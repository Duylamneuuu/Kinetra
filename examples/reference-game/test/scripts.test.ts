import assert from "node:assert/strict";
import test from "node:test";
import {
  ArenaPlayerController,
  ArenaGameManager,
  ArenaEnemyController,
} from "../scripts.js";

test("ArenaPlayerController health validation and restoration invariants", () => {
  const player = new ArenaPlayerController();

  // Valid states
  assert.equal(player.validateRestoreState({ health: 3 }).valid, true);
  assert.equal(player.validateRestoreState({ health: 1 }).valid, true);
  assert.equal(player.validateRestoreState({ health: 0 }).valid, true);

  // Invalid states
  assert.equal(player.validateRestoreState({ health: -1 }).valid, false);
  assert.equal(player.validateRestoreState({ health: 4 }).valid, false);
  assert.equal(player.validateRestoreState({ health: Number.NaN }).valid, false);
  assert.equal(player.validateRestoreState({ health: Number.POSITIVE_INFINITY }).valid, false);
  assert.equal(player.validateRestoreState({ health: "3" as unknown as number }).valid, false);

  // Prepare and commit
  const prep = player.prepareRestoreState({ health: 2, moveCount: 5 });
  prep.commit();
  assert.equal(player.health, 2);
  assert.equal(player.moveCount, 5);

  // Rollback
  const prep2 = player.prepareRestoreState({ health: 0, moveCount: 10 });
  prep2.rollback();
  assert.equal(player.health, 2);
  assert.equal(player.moveCount, 5);
});

test("ArenaGameManager health invariant and restoration alignment with player", () => {
  const manager = new ArenaGameManager();

  // Valid session health in [0, 3]
  assert.equal(manager.validateRestoreState({ playerHealth: 3 }).valid, true);
  assert.equal(manager.validateRestoreState({ playerHealth: 2 }).valid, true);
  assert.equal(manager.validateRestoreState({ playerHealth: 0 }).valid, true);
  assert.equal(manager.validateRestoreState({ session: { playerHealth: 1, status: "playing" } }).valid, true);

  // Invalid session health
  assert.equal(manager.validateRestoreState({ playerHealth: -1 }).valid, false);
  assert.equal(manager.validateRestoreState({ playerHealth: 4 }).valid, false);
  assert.equal(manager.validateRestoreState({ playerHealth: Number.NaN }).valid, false);
  assert.equal(manager.validateRestoreState({ playerHealth: Number.NEGATIVE_INFINITY }).valid, false);
  assert.equal(manager.validateRestoreState({ session: { playerHealth: -0.5 } }).valid, false);
  assert.equal(manager.validateRestoreState({ session: { playerHealth: 3.5 } }).valid, false);

  // Prepare and commit
  const prep = manager.prepareRestoreState({ playerHealth: 1, status: "playing", goalReached: false });
  prep.commit();
  assert.equal(manager.playerHealth, 1);
  assert.equal(manager.status, "playing");

  // Rollback
  const prep2 = manager.prepareRestoreState({ playerHealth: 0, status: "lost" });
  prep2.rollback();
  assert.equal(manager.playerHealth, 1);
  assert.equal(manager.status, "playing");
});

test("ArenaEnemyController state validation and restoration", () => {
  const enemy = new ArenaEnemyController();

  assert.equal(enemy.validateRestoreState({ state: "chasing", damageCooldown: 2 }).valid, true);
  assert.equal(enemy.validateRestoreState({ state: "attacking" }).valid, true);
  assert.equal(enemy.validateRestoreState({ state: "idle" }).valid, true);

  assert.equal(enemy.validateRestoreState({ state: "flying" }).valid, false);
  assert.equal(enemy.validateRestoreState({ damageCooldown: -1 }).valid, false);
});
