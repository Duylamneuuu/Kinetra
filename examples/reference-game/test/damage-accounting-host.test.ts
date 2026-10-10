import assert from "node:assert/strict";
import test from "node:test";
import { ScriptHost, type GameScriptContext } from "@kinetra/core";
import { ArenaEnemyController, ArenaGameManager } from "../scripts.js";

/**
 * #286.2: damageDealt accounting is exercised through the real ScriptHost (its
 * registration order, lifecycle gating and error isolation) instead of a hand-written
 * synchronous bus, so a change in how the host dispatches events cannot silently
 * desynchronise the enemy and the manager.
 */

type Order = "enemy-first" | "manager-first";

async function startHost(order: Order) {
  const host = new ScriptHost();
  const enemy = new ArenaEnemyController();
  const manager = new ArenaGameManager();
  const logs: Array<{ category: string; data?: Record<string, unknown> }> = [];
  const emitted: string[] = [];
  const emit = (event: string, payload?: unknown): void => {
    emitted.push(event);
    host.emit(event, payload);
  };
  const contextFor = (entityId: string): GameScriptContext => ({
    entityId,
    sceneId: "scene-test",
    emit,
    log: (_level, category, data) => {
      logs.push({ category, ...(data ? { data } : {}) });
    },
  });
  host.register({
    id: "enemy",
    scriptId: "arena.enemy",
    order: order === "enemy-first" ? 0 : 1,
    context: contextFor("enemy"),
    script: enemy,
  });
  host.register({
    id: "manager",
    scriptId: "arena.manager",
    order: order === "manager-first" ? 0 : 1,
    context: contextFor("manager"),
    script: manager,
  });
  await host.startAll();
  return { host, enemy, manager, logs, emitted, emit };
}

for (const order of ["enemy-first", "manager-first"] as const) {
  test(`ScriptHost (${order}): damageDealt equals the enemy's health lost and ignores hits on the body`, async () => {
    const { enemy, manager, emit, emitted } = await startHost(order);
    const startingHealth = enemy.health;
    assert.ok(startingHealth >= 2);

    emit("gameplay.enemyDamage", { amount: 1 });
    assert.equal(manager.stats.damageDealt, 1);
    assert.equal(emitted.filter((e) => e === "enemy.hurt").length, 1);

    // Finish the enemy one point at a time, then keep hitting the body.
    while (enemy.state !== "defeated") {
      emit("gameplay.enemyDamage", { amount: 1 });
    }
    assert.equal(manager.stats.damageDealt, startingHealth);
    assert.equal(manager.stats.enemiesDefeated, 1);

    const hurtCount = emitted.filter((e) => e === "enemy.hurt").length;
    emit("gameplay.enemyDamage", { amount: 7 });
    emit("gameplay.enemyDamage", { amount: 7 });
    assert.equal(emitted.filter((e) => e === "enemy.hurt").length, hurtCount);
    assert.equal(manager.stats.damageDealt, startingHealth);
    assert.equal(manager.stats.enemiesDefeated, 1);
  });

  test(`ScriptHost (${order}): a hit before startAll() is ignored, and a stopped manager stops counting`, async () => {
    const host = new ScriptHost();
    const manager = new ArenaGameManager();
    const emit = (event: string, payload?: unknown): void => host.emit(event, payload);
    host.register({
      id: "manager",
      context: { entityId: "manager", sceneId: "scene-test", emit },
      script: manager,
    });
    // Not started yet: the host must not deliver events to a "registered" script.
    host.emit("enemy.hurt", { damage: 3 });
    assert.equal(manager.stats.damageDealt, 0);

    await host.startAll();
    host.emit("enemy.hurt", { damage: 3 });
    assert.equal(manager.stats.damageDealt, 3);

    await host.stopAll();
    host.emit("enemy.hurt", { damage: 3 });
    assert.equal(manager.stats.damageDealt, 3);
    void order;
  });
}

test("ScriptHost: a throwing sibling script does not stop the manager from counting the hit", async () => {
  const host = new ScriptHost();
  const manager = new ArenaGameManager();
  const enemy = new ArenaEnemyController();
  const emit = (event: string, payload?: unknown): void => host.emit(event, payload);
  host.register({
    id: "boom",
    order: 0,
    context: { entityId: "boom", sceneId: "scene-test", emit },
    script: {
      onEvent() {
        throw new Error("sibling failed");
      },
    },
  });
  host.register({
    id: "enemy",
    order: 1,
    context: { entityId: "enemy", sceneId: "scene-test", emit },
    script: enemy,
  });
  host.register({
    id: "manager",
    order: 2,
    context: { entityId: "manager", sceneId: "scene-test", emit },
    script: manager,
  });
  await host.startAll();
  emit("gameplay.enemyDamage", { amount: 1 });
  assert.equal(manager.stats.damageDealt, 1);
  assert.equal(host.getExecutionState("boom")?.lifecycleState, "error");
  assert.equal(host.getExecutionState("manager")?.lifecycleState, "started");
});

test("ScriptHost: damageDealt from real enemy hits survives getState/restore of the manager", async () => {
  const { manager, emit } = await startHost("enemy-first");
  emit("gameplay.enemyDamage", { amount: 1 });
  emit("gameplay.enemyDamage", { amount: 1 });
  const saved = JSON.parse(JSON.stringify(manager.getState())) as Record<string, unknown>;
  assert.equal(manager.validateRestoreState(saved).valid, true);
  const fresh = new ArenaGameManager();
  fresh.prepareRestoreState(saved).commit();
  assert.equal(fresh.stats.damageDealt, 2);
});
