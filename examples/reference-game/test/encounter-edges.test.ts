import assert from "node:assert/strict";
import test from "node:test";
import {
  ArenaGameManager,
  ArenaPlayerController,
  readArenaDamageAmount,
} from "../scripts.js";

/**
 * Edge cases around the encounter flow: damage-payload and frame-time
 * sanitising, the lockdown challenge's win/lose transitions, and player input.
 */

interface Logged {
  event: string;
  data: unknown;
}

function ctx(logs: Logged[] = [], emitted: Array<{ event: string; payload: unknown }> = []): any {
  return {
    entityId: "m",
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    log: (_level: string, event: string, data: unknown) => logs.push({ event, data }),
  };
}

function sceneAt(position: [number, number, number]): any {
  return {
    findEntityByName: (name: string) => (name === "Player" ? { entityId: "p", name } : undefined),
    getEntityTransform: () => position,
  };
}

test("readArenaDamageAmount defaults, rejects bad payloads, and caps huge amounts", () => {
  assert.equal(readArenaDamageAmount(undefined), 1);
  assert.equal(readArenaDamageAmount(null), 1);
  assert.equal(readArenaDamageAmount("2"), 1);
  assert.equal(readArenaDamageAmount({}), 1);
  assert.equal(readArenaDamageAmount({ amount: "2" }), 1);
  assert.equal(readArenaDamageAmount({ amount: -1 }), 1);
  assert.equal(readArenaDamageAmount({ amount: Number.NaN }), 1);
  assert.equal(readArenaDamageAmount({ amount: Number.POSITIVE_INFINITY }), 1);
  assert.equal(readArenaDamageAmount({ amount: 0 }), 0);
  assert.equal(readArenaDamageAmount({ amount: 2.5 }), 2.5);
  assert.equal(readArenaDamageAmount({ amount: 1e300 }), Number.MAX_SAFE_INTEGER);
});

test("elapsedTimeMs sanitises bad or oversized frame deltas", () => {
  const cases: Array<[number, number]> = [
    [Number.NaN, 16],
    [Number.POSITIVE_INFINITY, 16],
    [-1, 16],
    [0, 16],
    ["0.5" as unknown as number, 16],
    [0.1, 100],
    [60, 1000], // a stalled frame is capped at one second
  ];
  for (const [delta, expectedMs] of cases) {
    const manager = new ArenaGameManager();
    manager.onUpdate(ctx(), delta);
    assert.equal(manager.stats.elapsedSteps, 1, `steps for ${String(delta)}`);
    assert.equal(manager.stats.elapsedTimeMs, expectedMs, `ms for ${String(delta)}`);
    assert.ok(Number.isFinite(manager.stats.elapsedTimeMs));
  }
});

test("lockdown challenge: picking up the core starts it, reaching extraction completes it", () => {
  const manager = new ArenaGameManager();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const c = ctx([], emitted);

  // Terminal first, then the core.
  manager.onUpdate({ ...c, scene: sceneAt([-5, 0.5, 2]) }, 1 / 60);
  assert.equal(manager.objectives[0]!.completed, true);
  assert.equal(manager.challenge.active, false);

  manager.onUpdate({ ...c, scene: sceneAt([5, 0.5, 2]) }, 1 / 60);
  assert.equal(manager.objectives[1]!.completed, true);
  assert.deepEqual(manager.challenge, {
    active: true,
    status: "active",
    enemySpeedMultiplier: 1.6,
    alertTriggered: true,
  });
  assert.ok(emitted.some((e) => e.event === "gameplay.challengeStarted"));

  // Standing on the core again must not restart the challenge or re-emit completion.
  const before = emitted.length;
  manager.onUpdate({ ...c, scene: sceneAt([5, 0.5, 2]) }, 1 / 60);
  assert.equal(emitted.length, before);

  manager.onUpdate({ ...c, scene: sceneAt([5, 0.1, -5]) }, 1 / 60);
  assert.equal(manager.status, "won");
  assert.equal(manager.goalReached, true);
  assert.deepEqual(
    manager.objectives.map((o) => o.completed),
    [true, true, true],
  );
  assert.equal(manager.challenge.status, "completed");
  assert.equal(manager.challenge.active, false);
  assert.equal(manager.getState().run && (manager.getState().run as { status: string }).status, "completed");
});

test("lockdown challenge fails when the player dies during it (onUpdate path)", () => {
  const manager = new ArenaGameManager();
  const logs: Logged[] = [];
  const c = ctx(logs);
  manager.onUpdate({ ...c, scene: sceneAt([5, 0.5, 2]) }, 1 / 60);
  assert.equal(manager.challenge.active, true);

  // A restored health of 0 without the lose transition having run yet.
  manager.playerHealth = 0;
  manager.onUpdate({ ...c, scene: sceneAt([0, 0, 0]) }, 1 / 60);
  assert.equal(manager.status, "lost");
  assert.equal(manager.challenge.status, "failed");
  assert.equal(manager.challenge.active, false);
  assert.equal(logs.filter((l) => l.event === "gameplay.runSummary").length, 1);
});

test("lockdown challenge fails when the player dies during it (event path)", () => {
  const manager = new ArenaGameManager();
  manager.onUpdate({ ...ctx(), scene: sceneAt([5, 0.5, 2]) }, 1 / 60);
  assert.equal(manager.challenge.active, true);
  manager.onEvent("gameplay.playerHealthChanged", { health: 0 }, ctx());
  assert.equal(manager.status, "lost");
  assert.equal(manager.challenge.status, "failed");
  assert.equal(manager.challenge.active, false);
});

test("reaching extraction wins even when the player's health is already 0 in the same frame", () => {
  // Win is evaluated before the health check, so a final-frame arrival counts.
  const manager = new ArenaGameManager();
  manager.playerHealth = 0;
  manager.onUpdate({ ...ctx(), scene: sceneAt([5, 0.1, -5]) }, 1 / 60);
  assert.equal(manager.status, "won");
});

test("health broadcasts are clamped and non-finite values are ignored", () => {
  const manager = new ArenaGameManager();
  const c = ctx();
  manager.onEvent("gameplay.playerHealthChanged", { health: 99 }, c);
  assert.equal(manager.playerHealth, 3);
  manager.onEvent("gameplay.playerHealthChanged", { health: Number.NaN }, c);
  manager.onEvent("gameplay.playerHealthChanged", { health: "1" }, c);
  manager.onEvent("gameplay.playerHealthChanged", undefined, c);
  assert.equal(manager.playerHealth, 3);
  assert.equal(manager.status, "playing");

  manager.onEvent("enemy.healthChanged", { health: -4 }, c);
  assert.equal(manager.enemyHealth, 0);
  manager.onEvent("enemy.healthChanged", { health: Number.POSITIVE_INFINITY }, c);
  assert.equal(manager.enemyHealth, 0);
  manager.onEvent("enemy.stateChanged", { state: 7 }, c);
  assert.equal(manager.enemyState, "chasing");
  manager.onEvent("enemy.stateChanged", { state: "telegraph" }, c);
  assert.equal(manager.enemyState, "telegraph");
});

test("player attack: out of range misses, in range hits, cooldown gates the next swing", () => {
  const player = new ArenaPlayerController();
  const logs: Logged[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  let enemyAt: [number, number, number] = [5, 0, 0];
  const context = {
    ...ctx(logs, emitted),
    input: { getAction: (name: string) => (name === "player.attack" ? 1 : 0) },
    transform: { getPosition: () => [0, 0, 0], translate: () => {} },
    scene: {
      findEntityByName: (name: string) => (name === "Enemy" ? { entityId: "e", name } : undefined),
      getEntityTransform: () => enemyAt,
    },
  };

  player.onUpdate(context, 1 / 60);
  assert.equal(logs.filter((l) => l.event === "player.attackMiss").length, 1);
  assert.equal(emitted.filter((e) => e.event === "gameplay.enemyDamage").length, 0);

  // Cooldown is 2 steps: the next step is still cooling down, the one after may swing.
  enemyAt = [1, 0, 0];
  player.onUpdate(context, 1 / 60);
  assert.equal(emitted.filter((e) => e.event === "gameplay.enemyDamage").length, 0);
  player.onUpdate(context, 1 / 60);
  assert.equal(emitted.filter((e) => e.event === "gameplay.enemyDamage").length, 1);
  assert.equal(player.lastAction, "player.attack");
});

test("opposing movement inputs cancel out instead of moving the player", () => {
  const player = new ArenaPlayerController();
  const moves: number[][] = [];
  const context = {
    ...ctx(),
    input: {
      getAction: (name: string) =>
        name === "player.moveLeft" || name === "player.moveRight" ? 1 : 0,
    },
    transform: { getPosition: () => [0, 0, 0], translate: (d: number[]) => moves.push(d) },
  };
  player.onUpdate(context, 1 / 60);
  assert.equal(moves.length, 0);
  assert.equal(player.moveCount, 0);
});

test("a dead player ignores input", () => {
  const player = new ArenaPlayerController();
  player.onEvent("gameplay.damage", { amount: 3 }, ctx());
  assert.equal(player.health, 0);
  const moves: number[][] = [];
  player.onUpdate(
    {
      ...ctx(),
      input: { getAction: () => 1 },
      transform: { getPosition: () => [0, 0, 0], translate: (d: number[]) => moves.push(d) },
    } as any,
    1 / 60,
  );
  assert.equal(moves.length, 0);
  assert.equal(player.moveCount, 0);
});
