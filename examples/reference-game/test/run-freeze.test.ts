import assert from "node:assert/strict";
import test from "node:test";
import { ArenaGameManager } from "../scripts.js";

/**
 * The run summary is logged once, at the moment the run ends (win or lose).
 * Anything that happens afterwards (the enemy keeps swinging at a dead player,
 * a late kill event) must not keep mutating the stats the summary reported.
 */

function ctx(logs: Array<{ event: string; data: unknown }> = []): any {
  return {
    entityId: "m",
    emit: () => {},
    log: (_level: string, event: string, data: unknown) => logs.push({ event, data }),
  };
}

test("stats freeze once the run is lost", () => {
  const manager = new ArenaGameManager();
  const c = ctx();
  manager.onEvent("gameplay.damage", { amount: 3 }, c);
  manager.onEvent("gameplay.playerHealthChanged", { health: 0 }, c);
  assert.equal(manager.status, "lost");
  const frozen = JSON.stringify(manager.getState());

  manager.onEvent("gameplay.damage", { amount: 1 }, c);
  manager.onEvent("gameplay.enemyDamage", { amount: 1 }, c);
  manager.onEvent("enemy.defeated", {}, c);
  assert.equal(JSON.stringify(manager.getState()), frozen);
  assert.equal(manager.stats.damageTaken, 3);
  assert.equal(manager.stats.enemiesDefeated, 0);
});

test("stats freeze once the run is won", () => {
  const manager = new ArenaGameManager();
  const c = ctx();
  const scene = {
    findEntityByName: () => ({ entityId: "p", name: "Player" }),
    getEntityTransform: () => [5, 0.5, -5],
  };
  manager.onUpdate({ ...c, scene }, 1 / 60);
  assert.equal(manager.status, "won");
  const frozen = JSON.stringify(manager.getState());

  manager.onEvent("gameplay.damage", { amount: 2 }, c);
  manager.onEvent("gameplay.enemyDamage", { amount: 2 }, c);
  manager.onEvent("enemy.defeated", {}, c);
  manager.onEvent("gameplay.playerHealthChanged", { health: 0 }, c);
  assert.equal(JSON.stringify(manager.getState()), frozen);
  assert.equal(manager.status, "won");
});

test("gameplay.runSummary is logged exactly once per run", () => {
  const logs: Array<{ event: string; data: unknown }> = [];
  const manager = new ArenaGameManager();
  const c = ctx(logs);
  manager.onEvent("gameplay.playerHealthChanged", { health: 0 }, c);
  manager.onEvent("gameplay.playerHealthChanged", { health: 0 }, c);
  manager.onUpdate(c, 1 / 60);
  manager.onUpdate(c, 1 / 60);
  assert.equal(logs.filter((l) => l.event === "gameplay.runSummary").length, 1);
});
