import assert from "node:assert/strict";
import test from "node:test";
import {
  ArenaEnemyController,
  ArenaGameManager,
  ArenaPlayerController,
  readArenaDamageAmount,
} from "../scripts.js";

/**
 * Property/fuzz tests for the Arena gameplay-script save contract.
 *
 * Invariant under test: whatever sequence of updates and events (including
 * hostile payloads such as NaN, ±Infinity, negative numbers, strings, null)
 * a script receives, its getState() must
 *   1. pass its own validateRestoreState(), and
 *   2. survive a JSON round trip (what the save system writes to disk) and
 *      restore into a fresh instance with an identical getState().
 * A violation means a save captured mid-run can no longer be loaded.
 */

type Vec3 = [number, number, number];

/** Deterministic PRNG (mulberry32) so every failure is reproducible by seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_NUMBERS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  -0.5,
  0,
  1e308,
  -1e308,
  Number.MIN_VALUE,
];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function randomNumber(rand: () => number): number {
  return rand() < 0.4 ? pick(rand, HOSTILE_NUMBERS) : Math.round((rand() * 8 - 2) * 100) / 100;
}

function randomPayload(rand: () => number, key: string): unknown {
  const roll = rand();
  if (roll < 0.1) return undefined;
  if (roll < 0.15) return null;
  if (roll < 0.2) return { [key]: "3" };
  if (roll < 0.25) return {};
  return { [key]: randomNumber(rand) };
}

const EVENTS: ReadonlyArray<{ name: string; key: string }> = [
  { name: "gameplay.damage", key: "amount" },
  { name: "gameplay.enemyDamage", key: "amount" },
  { name: "gameplay.playerHealthChanged", key: "health" },
  { name: "enemy.healthChanged", key: "health" },
  { name: "gameplay.challengeStarted", key: "multiplier" },
  { name: "enemy.stateChanged", key: "state" },
  { name: "enemy.defeated", key: "entityId" },
];

function createWorld(rand: () => number) {
  let playerPos: Vec3 = [0, 0.5, 0];
  let enemyPos: Vec3 = [3, 0.5, 3];
  const ctx = (entityId: string, own: () => Vec3, set: (p: Vec3) => void): any => ({
    entityId,
    emit: () => {},
    log: () => {},
    input: {
      getAction: () => (rand() < 0.5 ? 0 : randomNumber(rand)),
    },
    transform: {
      getPosition: () => own(),
      translate: (d: Vec3) => {
        const p = own();
        set([p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
      },
    },
    scene: {
      findEntityByName: (name: string) =>
        name === "Player" || name === "Enemy" ? { entityId: name, name } : undefined,
      getEntityTransform: (id: string) => (id === "Player" ? playerPos : enemyPos),
    },
  });
  return {
    player: ctx("Player", () => playerPos, (p) => (playerPos = p)),
    enemy: ctx("Enemy", () => enemyPos, (p) => (enemyPos = p)),
    manager: ctx("Manager", () => [0, 0, 0], () => {}),
    teleportPlayer(p: Vec3) {
      playerPos = p;
    },
  };
}

interface Restorable {
  getState(): Record<string, unknown>;
  validateRestoreState(state: Record<string, unknown>): { valid: boolean; error?: string };
  restoreState(state: Record<string, unknown>): void;
}

function assertSaveRoundTrip(
  label: string,
  script: Restorable,
  fresh: () => Restorable,
  seed: number,
  step: number,
): void {
  const state = script.getState();
  const validation = script.validateRestoreState(state);
  assert.equal(
    validation.valid,
    true,
    `${label} getState() rejected by its own validator (seed ${seed}, step ${step}): ${validation.error} ${JSON.stringify(state)}`,
  );
  const onDisk = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  const target = fresh();
  assert.doesNotThrow(
    () => target.restoreState(onDisk),
    `${label} JSON save failed to restore (seed ${seed}, step ${step}): ${JSON.stringify(onDisk)}`,
  );
  assert.deepEqual(
    target.getState(),
    script.getState(),
    `${label} restored state differs (seed ${seed}, step ${step})`,
  );
}

test("fuzz: Arena scripts always produce restorable saves under hostile updates and events", () => {
  const SEEDS = 200;
  const STEPS = 60;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed);
    const world = createWorld(rand);
    const player = new ArenaPlayerController();
    const enemy = new ArenaEnemyController();
    const manager = new ArenaGameManager();

    for (let step = 0; step < STEPS; step++) {
      const roll = rand();
      if (roll < 0.35) {
        const delta = rand() < 0.3 ? pick(rand, HOSTILE_NUMBERS) : 1 / 60;
        player.onUpdate(world.player, delta);
        enemy.onUpdate(world.enemy, delta);
        manager.onUpdate(world.manager, delta);
      } else if (roll < 0.45) {
        world.teleportPlayer([rand() * 14 - 7, 0.5, rand() * 14 - 7]);
      } else {
        const event = pick(rand, EVENTS);
        const payload = randomPayload(rand, event.key);
        player.onEvent(event.name, payload, world.player);
        enemy.onEvent(event.name, payload, world.enemy);
        manager.onEvent(event.name, payload, world.manager);
      }

      assertSaveRoundTrip("ArenaPlayerController", player, () => new ArenaPlayerController(), seed, step);
      assertSaveRoundTrip("ArenaEnemyController", enemy, () => new ArenaEnemyController(), seed, step);
      assertSaveRoundTrip("ArenaGameManager", manager, () => new ArenaGameManager(), seed, step);
    }
  }
});

test("fuzz: rejected restores leave state untouched; rollback after commit restores prior state", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rand = mulberry32(seed * 7919);
    const scripts: Array<{ label: string; script: Restorable & { prepareRestoreState(s: Record<string, unknown>): { commit(): void; rollback(): void } } }> = [
      { label: "player", script: new ArenaPlayerController() },
      { label: "enemy", script: new ArenaEnemyController() },
      { label: "manager", script: new ArenaGameManager() },
    ];
    for (const { label, script } of scripts) {
      const before = JSON.stringify(script.getState());
      const garbage: Record<string, unknown> = {
        health: randomNumber(rand),
        playerHealth: randomNumber(rand),
        moveCount: randomNumber(rand),
        damageCooldown: randomNumber(rand),
        state: pick(rand, ["chasing", "flying", 3, null]),
        status: pick(rand, ["playing", "won", "paused", 1]),
      };
      const validation = script.validateRestoreState(garbage);
      if (!validation.valid) {
        assert.throws(() => script.prepareRestoreState(garbage), new RegExp("Invalid"), `${label} seed ${seed}`);
        assert.equal(JSON.stringify(script.getState()), before, `${label} mutated by rejected restore (seed ${seed})`);
        continue;
      }
      const prepared = script.prepareRestoreState(garbage);
      prepared.commit();
      prepared.rollback();
      assert.equal(JSON.stringify(script.getState()), before, `${label} rollback after commit diverged (seed ${seed})`);
    }
  }
});

test("readArenaDamageAmount: finite non-negative amounts pass, everything else falls back to 1", () => {
  assert.equal(readArenaDamageAmount({ amount: 2 }), 2);
  assert.equal(readArenaDamageAmount({ amount: 0 }), 0);
  assert.equal(readArenaDamageAmount({ amount: 0.5 }), 0.5);
  assert.equal(readArenaDamageAmount(undefined), 1);
  assert.equal(readArenaDamageAmount(null), 1);
  assert.equal(readArenaDamageAmount({}), 1);
  assert.equal(readArenaDamageAmount({ amount: "2" }), 1);
  assert.equal(readArenaDamageAmount({ amount: Number.NaN }), 1);
  assert.equal(readArenaDamageAmount({ amount: Number.POSITIVE_INFINITY }), 1);
  assert.equal(readArenaDamageAmount({ amount: Number.NEGATIVE_INFINITY }), 1);
  assert.equal(readArenaDamageAmount({ amount: -1 }), 1);
  assert.equal(readArenaDamageAmount({ amount: 1e308 }), Number.MAX_SAFE_INTEGER);
});

test("regression: NaN damage no longer makes the player invulnerable or the save unloadable", () => {
  const player = new ArenaPlayerController();
  const manager = new ArenaGameManager();
  const ctx: any = { entityId: "p", emit: () => {}, log: () => {} };
  player.onEvent("gameplay.damage", { amount: Number.NaN }, ctx);
  manager.onEvent("gameplay.damage", { amount: Number.NaN }, ctx);
  assert.equal(player.health, 2);
  assert.equal(manager.stats.damageTaken, 1);
  assert.equal(player.validateRestoreState(player.getState()).valid, true);
  assert.equal(manager.validateRestoreState(manager.getState()).valid, true);
});

test("regression: zero/NaN challenge multiplier keeps enemy speed positive and restorable", () => {
  for (const multiplier of [0, Number.NaN, -2, Number.POSITIVE_INFINITY, 1e-9]) {
    const enemy = new ArenaEnemyController();
    enemy.onEvent("gameplay.challengeStarted", { multiplier }, { entityId: "e", log: () => {} } as any);
    assert.ok(enemy.speed > 0 && Number.isFinite(enemy.speed), `multiplier ${multiplier} -> speed ${enemy.speed}`);
    assert.equal(enemy.validateRestoreState(enemy.getState()).valid, true);
  }
});

test("regression: non-finite or out-of-range health broadcasts are ignored or clamped", () => {
  const manager = new ArenaGameManager();
  const ctx: any = { entityId: "m", emit: () => {}, log: () => {} };
  manager.onEvent("gameplay.playerHealthChanged", { health: Number.NaN }, ctx);
  manager.onEvent("enemy.healthChanged", { health: Number.POSITIVE_INFINITY }, ctx);
  assert.equal(manager.playerHealth, 3);
  assert.equal(manager.enemyHealth, 3);
  manager.onEvent("enemy.healthChanged", { health: 7 }, ctx);
  assert.equal(manager.enemyHealth, 3);
  manager.onEvent("gameplay.playerHealthChanged", { health: -4 }, ctx);
  assert.equal(manager.playerHealth, 0);
  assert.equal(manager.status, "lost");
});

test("regression: negative or non-finite frame delta never drives elapsedTimeMs negative", () => {
  const manager = new ArenaGameManager();
  const ctx: any = { entityId: "m", emit: () => {}, log: () => {} };
  for (const delta of [-1, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    manager.onUpdate(ctx, delta);
  }
  assert.equal(manager.stats.elapsedSteps, 4);
  assert.equal(manager.stats.elapsedTimeMs, 64);
  assert.equal(manager.validateRestoreState(manager.getState()).valid, true);
});
