import assert from "node:assert/strict";
import test from "node:test";
import { ArenaEnemyController, ArenaGameManager } from "../scripts.js";

/**
 * Save-file hardening: a hand-edited or corrupted save must be rejected by
 * validateRestoreState() instead of silently restoring a state the game can
 * never legitimately reach. JSON.parse("1e999") yields Infinity, and a string
 * where a boolean is expected would otherwise be coerced by Boolean().
 */

function challenge(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    challenge: {
      active: true,
      status: "active",
      enemySpeedMultiplier: 1.6,
      alertTriggered: true,
      ...overrides,
    },
  };
}

test("manager rejects non-finite or non-positive challenge.enemySpeedMultiplier", () => {
  const manager = new ArenaGameManager();
  const before = JSON.stringify(manager.getState());
  const hostile: unknown[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    (JSON.parse('{"v":1e999}') as { v: number }).v,
    0,
    -3,
    "1.6",
    null,
  ];
  for (const value of hostile) {
    const state = challenge({ enemySpeedMultiplier: value });
    assert.equal(
      manager.validateRestoreState(state).valid,
      false,
      `enemySpeedMultiplier ${String(value)} must be rejected`,
    );
    assert.throws(() => manager.prepareRestoreState(state), /Invalid ArenaGameManager state/);
    assert.equal(JSON.stringify(manager.getState()), before, "rejected restore must not mutate");
  }
  assert.equal(manager.validateRestoreState(challenge({})).valid, true);
});

test("manager rejects non-boolean challenge.alertTriggered and non-string enemyState", () => {
  const manager = new ArenaGameManager();
  assert.equal(manager.validateRestoreState(challenge({ alertTriggered: "no" })).valid, false);
  assert.equal(manager.validateRestoreState(challenge({ alertTriggered: 0 })).valid, false);
  assert.equal(manager.validateRestoreState({ enemyState: 5 }).valid, false);
  assert.equal(manager.validateRestoreState({ enemyState: "cooldown" }).valid, true);
});

test("enemy rejects inconsistent health/state pairs (defeated iff health is 0)", () => {
  const enemy = new ArenaEnemyController();
  const before = JSON.stringify(enemy.getState());
  assert.equal(enemy.validateRestoreState({ health: 2, state: "defeated" }).valid, false);
  assert.equal(enemy.validateRestoreState({ health: 0, state: "chasing" }).valid, false);
  assert.throws(() => enemy.prepareRestoreState({ health: 2, state: "defeated" }), /Invalid ArenaEnemyController state/);
  assert.equal(JSON.stringify(enemy.getState()), before);
  assert.equal(enemy.validateRestoreState({ health: 0, state: "defeated" }).valid, true);
  assert.equal(enemy.validateRestoreState({ health: 2, state: "cooldown" }).valid, true);
  // A real defeated enemy still produces a loadable save.
  const killed = new ArenaEnemyController();
  killed.onEvent("gameplay.enemyDamage", { amount: 99 }, { entityId: "e", emit: () => {}, log: () => {} } as any);
  assert.equal(killed.state, "defeated");
  assert.equal(new ArenaEnemyController().validateRestoreState(killed.getState()).valid, true);
});
