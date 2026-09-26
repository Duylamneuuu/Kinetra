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
  assert.equal(enemy.validateRestoreState({ state: "telegraph", telegraphTimer: 1 }).valid, true);
  assert.equal(enemy.validateRestoreState({ state: "attacking" }).valid, true);
  assert.equal(enemy.validateRestoreState({ state: "cooldown", damageCooldown: 2 }).valid, true);
  assert.equal(enemy.validateRestoreState({ state: "idle" }).valid, true);

  assert.equal(enemy.validateRestoreState({ state: "flying" }).valid, false);
  assert.equal(enemy.validateRestoreState({ damageCooldown: -1 }).valid, false);
  assert.equal(enemy.validateRestoreState({ telegraphTimer: -1 }).valid, false);
  assert.equal(enemy.validateRestoreState({ hurtCooldown: -1 }).valid, false);
  assert.equal(enemy.validateRestoreState({ state: "defeated", health: 0 }).valid, true);
  assert.equal(enemy.validateRestoreState({ health: -1 }).valid, false);
  assert.equal(enemy.validateRestoreState({ health: 4 }).valid, false);

  const prep = enemy.prepareRestoreState({
    health: 2,
    state: "telegraph",
    telegraphTimer: 1,
    hurtCooldown: 1,
  });
  prep.commit();
  assert.equal(enemy.health, 2);
  assert.equal(enemy.state, "telegraph");
  assert.equal(enemy.telegraphTimer, 1);
  assert.equal(enemy.hurtCooldown, 1);

  const prepRollback = enemy.prepareRestoreState({ health: 3, state: "chasing" });
  prepRollback.rollback();
  assert.equal(enemy.health, 2);
  assert.equal(enemy.state, "telegraph");
});

test("Combat event handling, hurt reaction, and defeat state transitions", () => {
  const enemy = new ArenaEnemyController();
  const eventsEmitted: Array<{ event: string; payload?: unknown }> = [];
  const fakeContext: any = {
    entityId: "enemy_1",
    emit: (event: string, payload?: unknown) => eventsEmitted.push({ event, payload }),
    log: () => {},
  };

  // Deal 1 damage -> triggers hurt event and reduces HP
  enemy.onEvent("gameplay.enemyDamage", { amount: 1 }, fakeContext);
  assert.equal(enemy.health, 2);
  assert.equal(enemy.hurtCooldown, 1);
  assert.equal(eventsEmitted.some((e) => e.event === "enemy.hurt"), true);
  assert.equal(eventsEmitted.some((e) => e.event === "enemy.healthChanged"), true);

  // Deal 2 damage -> defeat
  enemy.onEvent("gameplay.enemyDamage", { amount: 2 }, fakeContext);
  assert.equal(enemy.health, 0);
  assert.equal(enemy.state, "defeated");
  assert.equal(eventsEmitted.some((e) => e.event === "enemy.defeated"), true);

  // Further damage when defeated is ignored
  enemy.onEvent("gameplay.enemyDamage", { amount: 1 }, fakeContext);
  assert.equal(enemy.health, 0);
  assert.equal(enemy.state, "defeated");
});

test("Enemy attack cycle: chasing -> telegraph -> attacking -> cooldown -> chasing", () => {
  const enemy = new ArenaEnemyController();
  let enemyPos: [number, number, number] = [0, 0, 0];
  let playerPos: [number, number, number] = [1.0, 0, 0]; // within attackRange 1.6
  const eventsEmitted: Array<{ event: string; payload?: unknown }> = [];
  const fakeContext: any = {
    entityId: "enemy_1",
    transform: {
      getPosition: () => enemyPos,
      translate: (d: [number, number, number]) => {
        enemyPos = [enemyPos[0] + d[0], enemyPos[1] + d[1], enemyPos[2] + d[2]];
      },
    },
    scene: {
      findEntityByName: (name: string) => (name === "Player" ? { entityId: "player_1", name: "Player" } : undefined),
      getEntityTransform: () => playerPos,
    },
    emit: (event: string, payload?: unknown) => eventsEmitted.push({ event, payload }),
    log: () => {},
  };

  // Step 1: Enemy is within range -> transitions chasing -> telegraph (warning phase, no damage yet)
  assert.equal(enemy.state, "chasing");
  enemy.onUpdate(fakeContext, 0.016);
  assert.equal(enemy.state, "telegraph");
  assert.equal(eventsEmitted.some((e) => e.event === "enemy.telegraph"), true);
  assert.equal(eventsEmitted.some((e) => e.event === "gameplay.damage"), false);

  // Step 2: Player remains in range -> transitions telegraph -> attacking -> deals damage -> cooldown
  enemy.onUpdate(fakeContext, 0.016);
  assert.equal(enemy.state, "cooldown");
  assert.equal(enemy.damageCooldown, 2);
  assert.equal(eventsEmitted.some((e) => e.event === "gameplay.damage"), true);

  // Step 3: Cooldown tick 1
  enemy.onUpdate(fakeContext, 0.016);
  assert.equal(enemy.state, "cooldown");
  assert.equal(enemy.damageCooldown, 1);

  // Player moves out of range
  playerPos = [10.0, 0, 0];

  // Step 4: Cooldown expires, target is far -> transitions cooldown -> chasing
  enemy.onUpdate(fakeContext, 0.016);
  assert.equal(enemy.state, "chasing");
});

test("Enemy attack evade: player dodges during telegraph window", () => {
  const enemy = new ArenaEnemyController();
  let enemyPos: [number, number, number] = [0, 0, 0];
  let playerPos: [number, number, number] = [1.2, 0, 0]; // within attackRange 1.6
  const eventsEmitted: Array<{ event: string; payload?: unknown }> = [];
  const fakeContext: any = {
    entityId: "enemy_1",
    transform: {
      getPosition: () => enemyPos,
      translate: () => {},
    },
    scene: {
      findEntityByName: (name: string) => (name === "Player" ? { entityId: "player_1", name: "Player" } : undefined),
      getEntityTransform: () => playerPos,
    },
    emit: (event: string, payload?: unknown) => eventsEmitted.push({ event, payload }),
    log: () => {},
  };

  // Step 1: Enters telegraph
  enemy.onUpdate(fakeContext, 0.016);
  assert.equal(enemy.state, "telegraph");
  assert.equal(eventsEmitted.some((e) => e.event === "gameplay.damage"), false);

  // Player dodges out of range
  playerPos = [5.0, 0, 0];

  // Step 2: Attack evades -> returns to chasing without dealing damage!
  enemy.onUpdate(fakeContext, 0.016);
  assert.equal(enemy.state, "chasing");
  assert.equal(eventsEmitted.some((e) => e.event === "gameplay.damage"), false);
});

test("ArenaGameManager stats accumulation, encounter progression, and state restoration", () => {
  const manager = new ArenaGameManager();
  const eventsEmitted: Array<{ event: string; payload?: unknown }> = [];
  const fakeContext: any = {
    entityId: "mgr_1",
    emit: (event: string, payload?: unknown) => eventsEmitted.push({ event, payload }),
    log: () => {},
  };

  // Simulation steps accumulate elapsed metrics
  manager.onUpdate(fakeContext, 0.02);
  manager.onUpdate(fakeContext, 0.03);
  assert.equal(manager.stats.elapsedSteps, 2);
  assert.equal(manager.stats.elapsedTimeMs, 50);

  // Damage events update stats
  manager.onEvent("gameplay.damage", { amount: 1 }, fakeContext);
  assert.equal(manager.stats.damageTaken, 1);

  manager.onEvent("gameplay.enemyDamage", { amount: 2 }, fakeContext);
  assert.equal(manager.stats.damageDealt, 2);

  // Enemy defeated updates encounter and unlocks extraction
  manager.onEvent("enemy.defeated", {}, fakeContext);
  assert.equal(manager.stats.enemiesDefeated, 1);
  assert.equal(manager.encounter.enemyDefeated, true);
  assert.equal(manager.encounter.extractionUnlocked, true);
  assert.equal(manager.encounter.status, "defeated");
  assert.equal(eventsEmitted.some((e) => e.event === "gameplay.extractionUnlocked"), true);

  // Validation and restoration of stats and encounter
  assert.equal(
    manager.validateRestoreState({
      stats: { elapsedSteps: 10, elapsedTimeMs: 200, damageDealt: 3, damageTaken: 1, enemiesDefeated: 1 },
      encounter: { status: "defeated", enemyDefeated: true, extractionUnlocked: true },
    }).valid,
    true,
  );

  const prep = manager.prepareRestoreState({
    stats: { elapsedSteps: 42, elapsedTimeMs: 840, damageDealt: 5, damageTaken: 2, enemiesDefeated: 1 },
    encounter: { status: "defeated", enemyDefeated: true, extractionUnlocked: true },
  });
  prep.commit();
  assert.equal(manager.stats.elapsedSteps, 42);
  assert.equal(manager.stats.elapsedTimeMs, 840);
  assert.equal(manager.stats.damageDealt, 5);
  assert.equal(manager.encounter.status, "defeated");
  assert.equal(manager.encounter.extractionUnlocked, true);
});

test("ArenaEnemyController drives semantic animation service across all combat states", () => {
  const enemy = new ArenaEnemyController();
  const playedClips: Array<{ clip: string; loop?: boolean }> = [];
  let currentClip: string | undefined;

  const mockAnimation = {
    play(clipName: string, options?: { loop?: boolean }): boolean {
      playedClips.push({ clip: clipName, ...(options?.loop !== undefined ? { loop: options.loop } : {}) });
      currentClip = clipName;
      return true;
    },
    stop(): void {
      currentClip = undefined;
    },
    get activeClip() {
      return currentClip;
    },
    get playing() {
      return currentClip !== undefined;
    },
  };

  const context: any = {
    entityId: "enemy",
    animation: mockAnimation,
    transform: {
      getPosition: () => [5, 0.5, 5],
      translate: () => {},
    },
    scene: {
      findEntityByName: () => ({ entityId: "player", name: "Player" }),
      getEntityTransform: () => [5, 0.5, 5], // within attack range 1.6
    },
    emit: () => {},
    log: () => {},
  };

  // Start -> chasing -> walk
  enemy.onStart(context);
  assert.equal(mockAnimation.activeClip, "walk");
  assert.equal(enemy.getState().animationClip, "walk");

  // Step 1 -> player in range -> enters telegraph -> telegraph clip
  enemy.onUpdate(context, 1 / 60);
  assert.equal(enemy.state, "telegraph");
  assert.equal(mockAnimation.activeClip, "telegraph");
  assert.equal(enemy.getState().animationClip, "telegraph");

  // Step 2 -> telegraph completes -> attacks -> attack clip
  enemy.onUpdate(context, 1 / 60);
  assert.equal(mockAnimation.activeClip, "attack");
  assert.equal(enemy.getState().animationClip, "attack");

  // Enemy takes damage -> hurt reaction
  enemy.onEvent("gameplay.enemyDamage", { amount: 1 }, context);
  assert.equal(mockAnimation.activeClip, "hurt");
  assert.equal(enemy.getState().animationClip, "hurt");

  // Enemy takes lethal damage -> defeat clip
  enemy.onEvent("gameplay.enemyDamage", { amount: 2 }, context);
  assert.equal(enemy.state, "defeated");
  assert.equal(mockAnimation.activeClip, "defeat");
  assert.equal(enemy.getState().animationClip, "defeat");
});
