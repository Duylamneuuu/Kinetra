import assert from "node:assert/strict";
import test from "node:test";
import { ArenaEnemyController, ArenaGameManager } from "../scripts.js";

/**
 * damageDealt must count only hits the enemy actually took. The player emits
 * `gameplay.enemyDamage` for every swing that connects, including swings at an
 * enemy that is already defeated, and script events are delivered synchronously
 * and nested, so the manager can see the kill (`enemy.defeated`) either before
 * or after the hit that caused it depending on script order.
 */

interface Entry {
  script: { onEvent?: (event: string, payload: unknown, context: any) => void };
  context: any;
}

/** Minimal stand-in for ScriptHost.emit: synchronous, nested, in registration order. */
function bus(order: Array<"enemy" | "manager">) {
  const enemy = new ArenaEnemyController();
  const manager = new ArenaGameManager();
  const emitted: string[] = [];
  const entries: Entry[] = [];
  const emit = (event: string, payload?: unknown): void => {
    emitted.push(event);
    for (const entry of entries) {
      entry.script.onEvent?.(event, payload, entry.context);
    }
  };
  for (const name of order) {
    entries.push({
      script: name === "enemy" ? enemy : manager,
      context: { entityId: name, emit, log: () => {} },
    });
  }
  return { enemy, manager, emit, emitted };
}

for (const order of [
  ["enemy", "manager"],
  ["manager", "enemy"],
] as const) {
  test(`damageDealt counts the killing hit and ignores hits on the body (${order.join(" then ")})`, () => {
    const { enemy, manager, emit } = bus([...order]);
    const startingHealth = enemy.health;
    assert.ok(startingHealth >= 2, "fixture assumes the enemy survives a first hit");

    emit("gameplay.enemyDamage", { amount: 1 });
    assert.equal(manager.stats.damageDealt, 1);
    assert.equal(manager.stats.enemiesDefeated, 0);

    // Kill: the enemy applies its remaining health in one hit.
    emit("gameplay.enemyDamage", { amount: 1 });
    emit("gameplay.enemyDamage", { amount: 1 });
    assert.equal(enemy.state, "defeated");
    assert.equal(manager.stats.enemiesDefeated, 1);
    const afterKill = manager.stats.damageDealt;
    assert.equal(afterKill, startingHealth);

    // Hitting the body is a no-op for stats.
    emit("gameplay.enemyDamage", { amount: 1 });
    emit("gameplay.enemyDamage", { amount: 5 });
    assert.equal(manager.stats.damageDealt, afterKill);
    assert.equal(manager.stats.enemiesDefeated, 1);
    assert.equal(manager.encounter.enemyDefeated, true);
  });
}

test("enemy.hurt without a usable damage field counts as one hit, like a bare enemyDamage did", () => {
  const manager = new ArenaGameManager();
  const c: any = { entityId: "m", emit: () => {}, log: () => {} };
  manager.onEvent("enemy.hurt", {}, c);
  manager.onEvent("enemy.hurt", undefined, c);
  manager.onEvent("enemy.hurt", { damage: Number.NaN }, c);
  manager.onEvent("enemy.hurt", { damage: -3 }, c);
  assert.equal(manager.stats.damageDealt, 4);
});

test("a raw gameplay.enemyDamage no longer changes the manager's stats on its own", () => {
  const manager = new ArenaGameManager();
  const c: any = { entityId: "m", emit: () => {}, log: () => {} };
  manager.onEvent("gameplay.enemyDamage", { amount: 2 }, c);
  assert.equal(manager.stats.damageDealt, 0);
});

test("overkill hit reports the attempted amount once and the stat survives a save round trip", () => {
  const { enemy, manager, emit } = bus(["enemy", "manager"]);
  emit("gameplay.enemyDamage", { amount: 99 });
  assert.equal(enemy.health, 0);
  assert.equal(manager.stats.damageDealt, 99);
  const saved = JSON.parse(JSON.stringify(manager.getState())) as Record<string, unknown>;
  const restored = new ArenaGameManager();
  assert.equal(restored.validateRestoreState(saved).valid, true);
  restored.prepareRestoreState(saved).commit();
  assert.equal(restored.stats.damageDealt, 99);
});
