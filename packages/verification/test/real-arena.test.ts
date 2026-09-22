import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
  ARENA_ENTITY_PLAYER,
  ARENA_ENTITY_ENEMY,
  ARENA_ENTITY_MANAGER,
  ArenaPlayerController,
  ArenaGameManager,
  ARENA_SFX_HIT_ASSET_ID,
  ARENA_SFX_WIN_ASSET_ID,
  ARENA_SFX_LOSE_ASSET_ID,
} from "@kinetra/reference-game";
import {
  canRunRealElectronTests,  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

async function waitForLog(
  probe: KinetraRuntimeProbe,
  predicate: (log: { message: string; data?: Record<string, unknown> }) => boolean,
  timeoutMs = 4000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const logs = await probe.logs();
    if (logs.some(predicate)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function createArenaHost(saveDir?: string): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    ...(saveDir ? { saveDir } : {}),
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

test(
  "Arena Reference Game Slice 1 — Boot, Semantic Movement, Enemy Navmesh Chase, Win, Lose, Save/Load, and Failure Evidence",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Scenario 1: Arena boots into scene_arena with NavMesh, Player, Enemy, Manager
    // -----------------------------------------------------------------------
    await t.test("Scenario 1: boots directly into arena scene with NavMesh and initial playing state", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createArenaProject(),
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: true,
      });

      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "arena-boot-verification",
        seed: 101,
        target: "runtime",
        steps: [
          { type: "runtime.start", sceneId: ARENA_SCENE_ID },
          { type: "assert.equal", path: "running", expected: true },
          { type: "assert.equal", path: "sceneId", expected: ARENA_SCENE_ID },
          { type: "assert.equal", path: "state.navigation.hasNavMesh", expected: true },
          { type: "assert.equal", path: "state.game.status", expected: "playing" },
          { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
          { type: "assert.equal", path: "state.game.goalReached", expected: false },
          { type: "assert.equal", path: "state.byName.Player.position.0", expected: -5 },
          { type: "assert.equal", path: "state.byName.Player.position.2", expected: -5 },
          { type: "assert.equal", path: "state.byName.Enemy.position.0", expected: 5 },
          { type: "assert.equal", path: "state.byName.Enemy.position.2", expected: 5 },
          { type: "assert.logAbsent", minimumLevel: "error" },
          { type: "assert.screenshotValidPng" },
          { type: "runtime.stop" },
        ],
      };

      const runner = new AcceptanceRunner(probe);
      const report = await runner.run(manifest);
      assert.equal(report.passed, true, `Arena boot failed: ${report.failureReason}`);
    });

    // -----------------------------------------------------------------------
    // Scenario 2: Semantic player movement & deterministic enemy navmesh chase
    // -----------------------------------------------------------------------
    await t.test("Scenario 2: semantic input moves player and enemy navigates deterministically", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createArenaProject(),
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(ARENA_SCENE_ID, 102);
        const snapInit = await probe.snapshot();
        const initialEnemy = (snapInit.state.byName as Record<string, any>)["Enemy"];
        const initialPlayer = (snapInit.state.byName as Record<string, any>)["Player"];
        assert.ok(initialEnemy, "Initial Enemy entity must exist in snapshot");
        assert.ok(initialPlayer, "Initial Player entity must exist in snapshot");

        const initialEnemyPos: [number, number, number] = initialEnemy.position;
        const initialPlayerPos: [number, number, number] = initialPlayer.position;
        const initialDist = Math.hypot(
          initialEnemyPos[0] - initialPlayerPos[0],
          initialEnemyPos[2] - initialPlayerPos[2],
        );

        // Player moves forward (negative Z)
        await probe.input({ action: "player.moveForward", phase: "press", value: 1 });
        await probe.step(1);

        // Enemy steps toward player along NavMesh for 3 steps
        await probe.step(3);

        const snapPost = await probe.snapshot();
        const postEnemy = (snapPost.state.byName as Record<string, any>)["Enemy"];
        const postPlayer = (snapPost.state.byName as Record<string, any>)["Player"];
        assert.ok(postEnemy, "Post-step Enemy entity must exist in snapshot");
        assert.ok(postPlayer, "Post-step Player entity must exist in snapshot");

        const postEnemyPos: [number, number, number] = postEnemy.position;
        const postPlayerPos: [number, number, number] = postPlayer.position;
        const postDist = Math.hypot(
          postEnemyPos[0] - postPlayerPos[0],
          postEnemyPos[2] - postPlayerPos[2],
        );

        // A. Structured navigation state
        const lastPath = (snapPost.state.navigation as any)?.lastPath;
        assert.ok(lastPath, "Expected state.navigation.lastPath to exist");
        assert.equal(lastPath.success, true);
        assert.equal(lastPath.status, "complete");

        // B. Non-trivial path around central obstacle (pointCount >= 3)
        assert.ok(
          lastPath.pointCount >= 3,
          `Expected lastPath.pointCount >= 3 (intermediate obstacle waypoints), got: ${lastPath.pointCount}`,
        );

        // C. Enemy actually moved and closed distance to player
        assert.ok(
          postEnemyPos[0] !== initialEnemyPos[0] || postEnemyPos[2] !== initialEnemyPos[2],
          `Enemy must have moved from initial position [5, 0.5, 5], got: ${JSON.stringify(postEnemyPos)}`,
        );
        assert.ok(
          postDist < initialDist,
          `Post-step distance (${postDist}) must be less than initial distance (${initialDist})`,
        );

        // D. Enemy remains in chasing state
        assert.equal(postEnemy.gameplay?.state?.state, "chasing");

        await probe.stop();

        // Also verify formal AcceptanceManifest execution through AcceptanceRunner
        const manifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "arena-movement-and-chase",
          seed: 102,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            // Initial positions
            { type: "assert.equal", path: "state.byName.Player.position.0", expected: -5 },
            { type: "assert.equal", path: "state.byName.Player.position.2", expected: -5 },
            { type: "assert.equal", path: "state.byName.Enemy.position.0", expected: 5 },
            { type: "assert.equal", path: "state.byName.Enemy.position.2", expected: 5 },
            // Player moves forward (negative Z)
            { type: "input", action: "player.moveForward", phase: "press", value: 1 },
            { type: "runtime.step", steps: 1 },
            { type: "assert.equal", path: "state.byName.Player.position.2", expected: -6 },
            // Enemy steps toward player along NavMesh
            { type: "runtime.step", steps: 3 },
            // A. Structured navigation state proves lastPath
            { type: "assert.equal", path: "state.navigation.lastPath.success", expected: true },
            { type: "assert.equal", path: "state.navigation.lastPath.status", expected: "complete" },
            // B. Non-trivial path pointCount == 3 (navigating around central obstacle)
            { type: "assert.equal", path: "state.navigation.lastPath.pointCount", expected: 3 },
            // C. Enemy moved along path towards player
            { type: "assert.near", path: "state.byName.Enemy.position.0", expected: 3.51, tolerance: 0.2 },
            { type: "assert.near", path: "state.byName.Enemy.position.2", expected: 2.41, tolerance: 0.2 },
            // D. Confirm Enemy gameplay state remains "chasing" before attack range
            { type: "assert.equal", path: "state.byName.Enemy.gameplay.state.state", expected: "chasing" },
            { type: "assert.near", path: "state.byName.Player.gameplay.state.health", expected: 3, tolerance: 0 },
            { type: "assert.logAbsent", minimumLevel: "error" },
            { type: "runtime.stop" },
          ],
        };

        const runner = new AcceptanceRunner(probe);
        const report = await runner.run(manifest);
        assert.equal(report.passed, true, `Movement/chase manifest failed: ${report.failureReason}`);
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 3: WIN Path — Player reaches goal, status becomes "won" with audio
    // -----------------------------------------------------------------------
    await t.test("Scenario 3: player reaches exit goal and triggers deterministic WIN state", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createArenaProject(),
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      try {
        // Player starts at [-5, 0.5, -5], Goal is at [5, 0.1, -5] (radius 1.8)
        // Moving right (+X) 10 units reaches x = 5, distance to goal = 0
        const manifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "arena-win-path",
          seed: 103,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "assert.equal", path: "state.game.status", expected: "playing" },
            // Step 10 times right
            { type: "input", action: "player.moveRight", phase: "hold", value: 1 },
            { type: "runtime.step", steps: 10 },
            // Player now at x = 5, z = -5 -> Goal reached!
            { type: "assert.equal", path: "state.byName.Player.position.0", expected: 5 },
            { type: "assert.equal", path: "state.byName.Player.position.2", expected: -5 },
            { type: "assert.equal", path: "state.game.goalReached", expected: true },
            { type: "assert.equal", path: "state.game.status", expected: "won" },
            { type: "assert.logAbsent", minimumLevel: "error" },
            { type: "assert.screenshotValidPng" },
            { type: "runtime.stop" },
          ],
        };

        const runner = new AcceptanceRunner(probe);
        const report = await runner.run(manifest);
        assert.equal(report.passed, true, `Win path failed: ${report.failureReason}`);

        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message.includes("gameplay.win")),
          "Expected gameplay.win log event",
        );

        // 3. GAMEPLAY AUDIO EVENT PROOF: WIN event triggers real audio.played
        const winAudioLogged = await waitForLog(
          probe,
          (l) =>
            l.message === "audio.played" &&
            l.data?.assetId === ARENA_SFX_WIN_ASSET_ID &&
            l.data?.bus === "sfx",
        );
        assert.ok(
          winAudioLogged,
          `Expected audio.played log event for ${ARENA_SFX_WIN_ASSET_ID} on bus sfx`,
        );
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 4: LOSE Path — Enemy reaches player, deals damage until HP == 0
    // -----------------------------------------------------------------------
    await t.test("Scenario 4: enemy navigates to player, deals damage, triggers deterministic LOSE state", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => {
          // Place enemy closer to player to accelerate deterministic combat test
          // Player at [-5, 0.5, -5], Enemy placed at [-3.5, 0.5, -5] (distance 1.5, within attack range)
          const proj = createArenaProject();
          const enemy = proj.scenes[0]!.entities.find(e => e.id === ARENA_ENTITY_ENEMY)!;
          (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
          return proj;
        },
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      try {
        const manifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "arena-lose-path",
          seed: 104,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "assert.equal", path: "state.game.status", expected: "playing" },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
            // Step 1: Enemy attacks (cooldown set to 2) -> HP becomes 2
            { type: "runtime.step", steps: 1 },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 2 },
            // Step 2 & 3: Cooldown ticks down, Step 3: Enemy attacks again -> HP becomes 1
            { type: "runtime.step", steps: 2 },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 1 },
            // Step 4 & 5: Cooldown ticks down, Step 5: Enemy attacks again -> HP becomes 0 -> LOST!
            { type: "runtime.step", steps: 2 },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 0 },
            { type: "assert.equal", path: "state.game.status", expected: "lost" },
            { type: "assert.logAbsent", minimumLevel: "error" },
            { type: "assert.screenshotValidPng" },
            { type: "runtime.stop" },
          ],
        };

        const runner = new AcceptanceRunner(probe);
        const report = await runner.run(manifest);
        assert.equal(report.passed, true, `Lose path failed: ${report.failureReason}`);

        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message.includes("enemy.attack")),
          "Expected enemy.attack log event",
        );
        assert.ok(
          logs.some((l) => l.message.includes("gameplay.lose")),
          "Expected gameplay.lose log event",
        );

        // 3. GAMEPLAY AUDIO EVENT PROOF: Attack and Lose events trigger real audio.played
        const hitAudioLogged = await waitForLog(
          probe,
          (l) =>
            l.message === "audio.played" &&
            l.data?.assetId === ARENA_SFX_HIT_ASSET_ID &&
            l.data?.bus === "sfx",
        );
        assert.ok(
          hitAudioLogged,
          `Expected audio.played log event for ${ARENA_SFX_HIT_ASSET_ID} on bus sfx`,
        );

        const loseAudioLogged = await waitForLog(
          probe,
          (l) =>
            l.message === "audio.played" &&
            l.data?.assetId === ARENA_SFX_LOSE_ASSET_ID &&
            l.data?.bus === "sfx",
        );
        assert.ok(
          loseAudioLogged,
          `Expected audio.played log event for ${ARENA_SFX_LOSE_ASSET_ID} on bus sfx`,
        );
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 5: File-Backed Save/Load Persistence Across Electron Processes
    // -----------------------------------------------------------------------
    await t.test("Scenario 5: Process A saves intermediate progress -> terminates -> Process B restores and finishes game", async () => {
      const tempSaveDir = await mkdtemp(join(tmpdir(), "kinetra-arena-save-test-"));

      try {
        // --- PROCESS A ---
        const hostA = createArenaHost(tempSaveDir);
        const probeA = new KinetraRuntimeProbe({
          host: hostA,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          const manifestA: AcceptanceManifest = {
            schemaVersion: 1,
            suite: "arena-save-process-a",
            seed: 105,
            target: "runtime",
            steps: [
              { type: "runtime.start", sceneId: ARENA_SCENE_ID },
              // Move player 2 units right to [-3, 0.5, -5]
              { type: "input", action: "player.moveRight", phase: "press", value: 1 },
              { type: "runtime.step", steps: 1 },
              { type: "input", action: "player.moveRight", phase: "press", value: 1 },
              { type: "runtime.step", steps: 1 },
              { type: "assert.equal", path: "state.byName.Player.position.0", expected: -3 },
              { type: "assert.equal", path: "state.byName.Player.gameplay.state.moveCount", expected: 2 },
              // Capture save to disk
              { type: "save.capture", slotId: "arena-progress" },
              { type: "runtime.stop" },
            ],
          };

          const runnerA = new AcceptanceRunner(probeA);
          const reportA = await runnerA.run(manifestA);
          assert.equal(reportA.passed, true, `Process A failed: ${reportA.failureReason}`);
        } finally {
          await hostA.close();
        }

        // Verify save file written to desktop disk
        const savedFiles = await readdir(tempSaveDir);
        assert.ok(
          savedFiles.some(f => f.includes("arena-progress")),
          `Expected arena-progress save file in ${tempSaveDir}, found ${savedFiles.join(", ")}`,
        );

        // --- PROCESS B ---
        const hostB = createArenaHost(tempSaveDir);
        const probeB = new KinetraRuntimeProbe({
          host: hostB,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        const manifestB: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "arena-restore-process-b",
          seed: 106,
          target: "runtime",
          steps: [
            // Start clean arena scene (player at initial position -5)
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "assert.equal", path: "state.byName.Player.position.0", expected: -5 },
            { type: "assert.equal", path: "state.byName.Player.gameplay.state.moveCount", expected: 0 },
            // Restore saved progress from disk
            { type: "save.load", slotId: "arena-progress" },
            // Verify restored position and gameplay state
            { type: "assert.equal", path: "state.byName.Player.position.0", expected: -3 },
            { type: "assert.equal", path: "state.byName.Player.gameplay.state.moveCount", expected: 2 },
            { type: "assert.equal", path: "state.game.status", expected: "playing" },
            // Continue gameplay from restored position to Goal (8 units right to reach x = 5)
            { type: "input", action: "player.moveRight", phase: "hold", value: 1 },
            { type: "runtime.step", steps: 8 },
            { type: "assert.equal", path: "state.byName.Player.position.0", expected: 5 },
            { type: "assert.equal", path: "state.game.goalReached", expected: true },
            { type: "assert.equal", path: "state.game.status", expected: "won" },
            { type: "assert.screenshotValidPng" },
            { type: "runtime.stop" },
          ],
        };

        const runnerB = new AcceptanceRunner(probeB);
        const reportB = await runnerB.run(manifestB);
        assert.equal(reportB.passed, true, `Process B failed: ${reportB.failureReason}`);
      } finally {
        await rm(tempSaveDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 6: Deliberate failure produces structured failed-step evidence
    // -----------------------------------------------------------------------
    await t.test("Scenario 6: deliberate assertion failure outputs structured failed-step evidence", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createArenaProject(),
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: true,
      });

      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "arena-deliberate-failure",
        seed: 107,
        target: "runtime",
        steps: [
          { type: "runtime.start", sceneId: ARENA_SCENE_ID },
          // Deliberate failure: expecting status "won" immediately on start
          { type: "assert.equal", path: "state.game.status", expected: "won" },
          { type: "runtime.stop" },
        ],
      };

      const runner = new AcceptanceRunner(probe);
      const report = await runner.run(manifest);

      assert.equal(report.passed, false, "Report must fail for false assertion");
      assert.ok(report.failureReason, "Report must provide failureReason");
      assert.ok(report.failedSteps, "Report must provide failedSteps");
      assert.equal(report.failedSteps?.length, 1, "Failed step count must be 1");
      assert.equal(report.failedSteps?.[0]?.index, 1, "Failed step index must point to step 1");
      assert.ok(
        report.failedSteps?.[0]?.error?.includes("Expected state.game.status = \"won\", got \"playing\""),
        `Expected descriptive step assertion error, got ${report.failedSteps?.[0]?.error}`,
      );
    });

    // -----------------------------------------------------------------------
    // Scenario 7: Health Invariant Verification
    // -----------------------------------------------------------------------
    await t.test("Scenario 7: health invariants enforce [0, 3] bounds on player and game manager", () => {
      const player = new ArenaPlayerController();
      assert.equal(player.validateRestoreState({ health: 3 }).valid, true);
      assert.equal(player.validateRestoreState({ health: 0 }).valid, true);
      assert.equal(player.validateRestoreState({ health: -1 }).valid, false);
      assert.equal(player.validateRestoreState({ health: 4 }).valid, false);
      assert.equal(player.validateRestoreState({ health: Number.NaN }).valid, false);

      const manager = new ArenaGameManager();
      assert.equal(manager.validateRestoreState({ playerHealth: 3 }).valid, true);
      assert.equal(manager.validateRestoreState({ playerHealth: 0 }).valid, true);
      assert.equal(manager.validateRestoreState({ playerHealth: -1 }).valid, false);
      assert.equal(manager.validateRestoreState({ playerHealth: 4 }).valid, false);
      assert.equal(manager.validateRestoreState({ session: { playerHealth: -0.5 } }).valid, false);
      assert.equal(manager.validateRestoreState({ session: { playerHealth: 3.5 } }).valid, false);
    });
  },
);
