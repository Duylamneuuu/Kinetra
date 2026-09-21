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
  ARENA_ENTITY_TERMINAL,
  ARENA_ENTITY_CORE,
  ARENA_ENTITY_GOAL,
} from "@kinetra/reference-game";
import {
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

function createArenaHost(saveDir?: string): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    ...(saveDir ? { saveDir } : {}),
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

function assertValidPng(bytes: Uint8Array, label: string): void {
  assert.ok(bytes.byteLength > 1000, `${label} PNG must exceed 1000 bytes, got ${bytes.byteLength}`);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < header.length; i++) {
    assert.equal(
      bytes[i],
      header[i],
      `${label} PNG byte[${i}] must match standard PNG magic header`,
    );
  }
}

test(
  "Gameplay Loop Expansion Slice 3 — Run Status, 3 Objectives, Lockdown Challenge, Multi-Process Save/Load, Win/Lose Flow",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Scenario 1: New Game Run Initialization & HUD State Projection
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 1: New Game initializes fresh run with run.status == active, 3 uncompleted objectives, idle challenge",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          const manifest: AcceptanceManifest = {
            schemaVersion: 1,
            suite: "gameplay-loop-init",
            seed: 301,
            target: "runtime",
            steps: [
              { type: "runtime.start", sceneId: ARENA_SCENE_ID },
              { type: "assert.equal", path: "running", expected: true },
              { type: "assert.equal", path: "state.shell.mode", expected: "playing" },
              { type: "assert.equal", path: "state.game.status", expected: "playing" },
              { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
              { type: "assert.equal", path: "state.game.run.status", expected: "active" },
              { type: "assert.equal", path: "state.game.objectives.length", expected: 3 },
              {
                type: "assert.equal",
                path: "state.game.objectives.0.id",
                expected: "obj_activate_terminal",
              },
              {
                type: "assert.equal",
                path: "state.game.objectives.0.completed",
                expected: false,
              },
              {
                type: "assert.equal",
                path: "state.game.objectives.1.id",
                expected: "obj_retrieve_core",
              },
              {
                type: "assert.equal",
                path: "state.game.objectives.1.completed",
                expected: false,
              },
              {
                type: "assert.equal",
                path: "state.game.objectives.2.id",
                expected: "obj_survive_escape",
              },
              {
                type: "assert.equal",
                path: "state.game.objectives.2.completed",
                expected: false,
              },
              { type: "assert.equal", path: "state.game.challenge.active", expected: false },
              { type: "assert.equal", path: "state.game.challenge.status", expected: "idle" },
              { type: "assert.screenshotValidPng" },
              { type: "runtime.stop" },
            ],
          };

          const runner = new AcceptanceRunner(probe);
          const report = await runner.run(manifest);
          assert.equal(report.passed, true, `Init run failed: ${report.failureReason}`);

          // Raw PNG frame validation
          await probe.start(ARENA_SCENE_ID, 301);
          const frame = await probe.captureFrame();
          assertValidPng(frame, "Gameplay Loop HUD Initial Frame");
          await probe.stop();
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 2: Objective 1 Completion (Security Console)
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 2: Player navigates to Security Console and completes first objective",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 302);

          // Player starts at [-5, 0.5, -5]. Security Console is at [-5, 0.5, 2].
          // moveBackward moves dz = +1.0 per step -> 7 steps reaches z = 2.
          await probe.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probe.step(7);
          await probe.input({ action: "player.moveBackward", phase: "release" });

          const snap = await probe.snapshot();
          const player = (snap.state.byName as any)["Player"];
          assert.ok(player);
          assert.equal(player.position[0], -5);
          assert.equal(player.position[2], 2);

          const game = snap.state.game as any;
          assert.ok(game);
          assert.equal(game.objectives[0].id, "obj_activate_terminal");
          assert.equal(game.objectives[0].completed, true, "Objective 1 must be completed");
          assert.equal(game.objectives[1].completed, false, "Objective 2 must remain incomplete");
          assert.equal(game.objectives[2].completed, false, "Objective 3 must remain incomplete");
          assert.equal(game.run.status, "active");

          // Verify structured log evidence
          const logs = await probe.logs();
          const objLog = logs.find(
            (l) =>
              l.message === "objective.completed" &&
              l.data?.id === "obj_activate_terminal",
          );
          assert.ok(objLog, "Expected objective.completed structured log for Security Console");

          // Capture HUD frame
          const frame = await probe.captureFrame();
          assertValidPng(frame, "Objective 1 Completed HUD");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 3: Objective 2 Completion & Lockdown Challenge Activation
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 3: Player retrieves Power Core, completes Objective 2, and triggers Lockdown Challenge",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 303);

          // 1. Move to Security Console [-5, 0.5, 2]
          await probe.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probe.step(7);
          await probe.input({ action: "player.moveBackward", phase: "release" });

          // 2. Flank north along outer perimeter to z = 5
          await probe.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probe.step(3);
          await probe.input({ action: "player.moveBackward", phase: "release" });

          // 3. Move along perimeter to x = 5
          await probe.input({ action: "player.moveRight", phase: "hold", value: 1 });
          await probe.step(10);
          await probe.input({ action: "player.moveRight", phase: "release" });

          // 4. Move forward to Power Core at [5, 0.5, 2]
          await probe.input({ action: "player.moveForward", phase: "hold", value: 1 });
          await probe.step(3);
          await probe.input({ action: "player.moveForward", phase: "release" });

          const snap = await probe.snapshot();
          const player = (snap.state.byName as any)["Player"];
          assert.ok(player);
          assert.equal(player.position[0], 5);
          assert.equal(player.position[2], 2);

          const game = snap.state.game as any;
          assert.ok(game);
          assert.equal(game.objectives[0].completed, true, "Objective 1 must be completed");
          assert.equal(game.objectives[1].completed, true, "Objective 2 must be completed");
          assert.equal(game.objectives[2].completed, false, "Objective 3 must remain incomplete");

          // Verify Lockdown Survival Challenge state
          assert.equal(game.challenge.active, true, "Lockdown challenge must be active");
          assert.equal(game.challenge.status, "active", "Challenge status must be active");
          assert.equal(game.challenge.enemySpeedMultiplier, 1.6);
          assert.equal(game.challenge.alertTriggered, true);

          // Verify enemy boosted speed (1.28)
          const enemy = (snap.state.byName as any)["Enemy"];
          assert.ok(enemy);
          assert.equal(
            enemy.gameplay?.state?.speed,
            1.28,
            "Enemy speed must be boosted to 1.28 (0.8 * 1.6)",
          );

          // Verify structured logs for challenge start
          const logs = await probe.logs();
          const challengeLog = logs.find(
            (l) =>
              l.message === "challenge.started" &&
              l.data?.challenge === "lockdown",
          );
          assert.ok(challengeLog, "Expected challenge.started log for lockdown");

          const frame = await probe.captureFrame();
          assertValidPng(frame, "Lockdown Challenge Active HUD");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 4: Multi-Process Save & Restore Invariant
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 4: Process A saves progress with Objective 1 completed -> Process B restores exact state and finishes run",
      async () => {
        const saveDir = await mkdtemp(join(tmpdir(), "kinetra-loop-save-"));

        try {
          // --- Process A: Play and Save ---
          const hostA = createArenaHost(saveDir);
          const probeA = new KinetraRuntimeProbe({
            host: hostA,
            project: () => createArenaProject(),
            initialRevision: 0,
            assets: arenaAudioAssets,
            closeOnStop: false,
          });

          await probeA.start(ARENA_SCENE_ID, 304);

          // Advance player 7 steps backward to Security Console [-5, 0.5, 2]
          await probeA.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probeA.step(7);
          await probeA.input({ action: "player.moveBackward", phase: "release" });

          // Flank north 3 steps to z = 5, then 3 steps right to [-2, 0.5, 5]
          await probeA.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probeA.step(3);
          await probeA.input({ action: "player.moveBackward", phase: "release" });

          await probeA.input({ action: "player.moveRight", phase: "hold", value: 1 });
          await probeA.step(3);
          await probeA.input({ action: "player.moveRight", phase: "release" });

          const snapA = await probeA.snapshot();
          const playerA = (snapA.state.byName as any)["Player"];
          assert.equal(playerA.position[0], -2);
          assert.equal(playerA.position[2], 5);
          assert.equal((snapA.state.game as any)?.objectives[0].completed, true);
          assert.equal((snapA.state.game as any)?.objectives[1].completed, false);
          assert.equal((snapA.state.game as any)?.challenge.status, "idle");

          const savedHealth = (snapA.state.game as any)?.playerHealth;
          assert.ok(typeof savedHealth === "number" && savedHealth > 0);

          // Save game
          const saveResult = await probeA.captureSave("arena-progress");
          assert.equal(saveResult.success, true);

          await probeA.close();

          // --- Process B: Fresh Launch & Restore ---
          const hostB = createArenaHost(saveDir);
          const probeB = new KinetraRuntimeProbe({
            host: hostB,
            project: () => createArenaProject(),
            initialRevision: 0,
            assets: arenaAudioAssets,
            closeOnStop: true,
          });

          await probeB.start(ARENA_SCENE_ID, 304);

          // Restore save slot
          const loadResult = await probeB.loadSave({ slotId: "arena-progress" });
          assert.equal(loadResult.success, true);

          // Verify restored state in fresh Process B
          const snapB = await probeB.snapshot();
          const playerB = (snapB.state.byName as any)["Player"];
          assert.equal(playerB.position[0], -2);
          assert.equal(playerB.position[2], 5);
          assert.equal((snapB.state.game as any)?.playerHealth, savedHealth);
          assert.equal((snapB.state.game as any)?.run.status, "active");
          assert.equal((snapB.state.game as any)?.objectives[0].completed, true);
          assert.equal((snapB.state.game as any)?.objectives[1].completed, false);
          assert.equal((snapB.state.game as any)?.objectives[2].completed, false);
          assert.equal((snapB.state.game as any)?.challenge.status, "idle");

          // Continue run in Process B: move 7 steps right along z = 5 to reach [5, 0.5, 5]
          await probeB.input({ action: "player.moveRight", phase: "hold", value: 1 });
          await probeB.step(7);
          await probeB.input({ action: "player.moveRight", phase: "release" });

          // Move 3 steps forward to reach Power Core at [5, 0.5, 2]
          await probeB.input({ action: "player.moveForward", phase: "hold", value: 1 });
          await probeB.step(3);
          await probeB.input({ action: "player.moveForward", phase: "release" });

          const snapCore = await probeB.snapshot();
          assert.equal((snapCore.state.game as any)?.objectives[1].completed, true);
          assert.equal((snapCore.state.game as any)?.challenge.status, "active");

          // Move 7 steps forward (negative Z) to reach Extraction Goal at [5, 0.1, -5]
          await probeB.input({ action: "player.moveForward", phase: "hold", value: 1 });
          await probeB.step(7);
          await probeB.input({ action: "player.moveForward", phase: "release" });

          const snapWin = await probeB.snapshot();
          assert.equal((snapWin.state.game as any)?.objectives[2].completed, true);
          assert.equal((snapWin.state.game as any)?.challenge.status, "completed");
          assert.equal((snapWin.state.game as any)?.run.status, "completed");
          assert.equal((snapWin.state.game as any)?.status, "won");
          assert.equal((snapWin.state.shell as any)?.mode, "won");

          await probeB.close();
        } catch (err) {
          console.error("SCENARIO 4 ERROR:", err);
          throw err;
        } finally {
          await rm(saveDir, { recursive: true, force: true });
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 5: Challenge Success (Complete Win Flow with PNG)
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 5: Complete gameplay loop from Objective 1 -> 2 -> Lockdown -> Goal triggers WIN state",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 305);

          // 1. Move to Console [-5, 0.5, 2] (7 steps backward)
          await probe.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probe.step(7);
          await probe.input({ action: "player.moveBackward", phase: "release" });

          // 2. Flank north along outer perimeter to z = 5 (3 steps backward)
          await probe.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probe.step(3);
          await probe.input({ action: "player.moveBackward", phase: "release" });

          // 3. Move along outer perimeter to x = 5 (10 steps right)
          await probe.input({ action: "player.moveRight", phase: "hold", value: 1 });
          await probe.step(10);
          await probe.input({ action: "player.moveRight", phase: "release" });

          // 4. Move forward to Power Core at [5, 0.5, 2] (3 steps forward)
          await probe.input({ action: "player.moveForward", phase: "hold", value: 1 });
          await probe.step(3);
          await probe.input({ action: "player.moveForward", phase: "release" });

          // 5. Move to Extraction Goal [5, 0.1, -5] (7 steps forward)
          await probe.input({ action: "player.moveForward", phase: "hold", value: 1 });
          await probe.step(7);
          await probe.input({ action: "player.moveForward", phase: "release" });

          const snap = await probe.snapshot();
          const game = snap.state.game as any;
          assert.ok(game);
          assert.equal(game.objectives[0].completed, true);
          assert.equal(game.objectives[1].completed, true);
          assert.equal(game.objectives[2].completed, true);
          assert.equal(game.challenge.status, "completed");
          assert.equal(game.challenge.active, false);
          assert.equal(game.run.status, "completed");
          assert.equal(game.status, "won");
          assert.equal((snap.state.shell as any)?.mode, "won");

          // Capture Victory frame
          const frame = await probe.captureFrame();
          assertValidPng(frame, "Gameplay Loop Victory Frame");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 6: Challenge Failure (Complete Lose Flow with PNG)
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 6: Player taking lethal damage during active run triggers LOSE state and run.status == failed",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => {
            // Place enemy adjacent to player to accelerate combat test:
            // Player at [-5, 0.5, -5], Enemy at [-3.5, 0.5, -5] (distance 1.5, within attack range 1.6)
            const proj = createArenaProject();
            const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
            (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
            return proj;
          },
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 306);

          // Step 1: Enemy attacks -> HP 2
          await probe.step(1);
          const snap1 = await probe.snapshot();
          assert.equal((snap1.state.game as any)?.playerHealth, 2);

          // Step 2-3: Cooldown ticks down, Step 3: Enemy attacks -> HP 1
          await probe.step(2);
          const snap2 = await probe.snapshot();
          assert.equal((snap2.state.game as any)?.playerHealth, 1);

          // Step 4-5: Cooldown ticks down, Step 5: Enemy attacks -> HP 0 -> LOST!
          await probe.step(2);
          const snap3 = await probe.snapshot();
          const game = snap3.state.game as any;
          assert.equal(game?.playerHealth, 0, "Player health must reach 0");
          assert.equal(game?.status, "lost", "Game status must be lost");
          assert.equal(game?.run.status, "failed", "Run status must be failed");
          assert.equal((snap3.state.shell as any)?.mode, "lost", "Shell mode must be lost");

          // Capture Defeat frame
          const frame = await probe.captureFrame();
          assertValidPng(frame, "Gameplay Loop Defeat Frame");
        } finally {
          await probe.close();
        }
      },
    );
  },
);
