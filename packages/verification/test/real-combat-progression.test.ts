import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
  ARENA_ENTITY_ENEMY,
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
  "Combat Feel & Encounter Progression Slice 5 — Telegraph State Machine, Reaction Window, Encounter Progression, Run Statistics, Multi-Process Save/Load, Packaged Proof",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Scenario 1: Enemy Attack Telegraph Visible Before Damage
    // -----------------------------------------------------------------------
    await t.test("Scenario 1: Enemy telegraphs attack before inflicting damage", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => {
          // Player starts at [-5, 0.5, -5]; place enemy within attackRange 1.6m at [-3.5, 0.5, -5] (dist 1.5)
          const proj = createArenaProject();
          const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
          (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
          return proj;
        },
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(ARENA_SCENE_ID, 501);

        const snapInit = await probe.snapshot();
        assert.equal((snapInit.state.game as any)?.playerHealth, 3);
        assert.equal((snapInit.state.game as any)?.enemyHealth, 3);

        // Step 1: Enemy enters telegraph state; no damage dealt yet!
        await probe.step(1);

        const snapTelegraph = await probe.snapshot();
        assert.equal(
          (snapTelegraph.state.game as any)?.enemyState,
          "telegraph",
          "Enemy state must be 'telegraph' during warning phase",
        );
        assert.equal(
          (snapTelegraph.state.game as any)?.playerHealth,
          3,
          "Player health must remain 3 during telegraph warning phase",
        );

        // Verify telegraph log event
        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message === "enemy.attackTelegraph"),
          "Expected enemy.attackTelegraph log event",
        );

        // Capture frame during telegraph
        const frame = await probe.captureFrame();
        assertValidPng(frame, "Scenario 1 Enemy Telegraph");
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 2: Player Reaction Window — Reaction / Avoid & Damage Trading
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 2: Player can react to telegraph: evading avoids damage, while trading executes damage",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => {
            const proj = createArenaProject();
            const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
            (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
            return proj;
          },
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 502);

          // --- Part A: Evade Attack ---
          // Step 1: Enemy enters telegraph
          await probe.step(1);
          const snap1 = await probe.snapshot();
          assert.equal((snap1.state.game as any)?.enemyState, "telegraph");
          assert.equal((snap1.state.game as any)?.playerHealth, 3);

          // Player reacts: moves backward (+Z direction) to increase distance
          await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
          await probe.step(1);

          // Player position moved from [-5, 0.5, -5] to [-5, 0.5, -4]
          // Distance to enemy at [-3.5, 0.5, -5] is hypot(1.5, 1.0) = 1.80 > 1.6 (out of range!)
          const snapEvaded = await probe.snapshot();
          assert.equal(
            (snapEvaded.state.game as any)?.playerHealth,
            3,
            "Player health must remain 3 after successful evasion",
          );
          assert.equal(
            (snapEvaded.state.game as any)?.enemyState,
            "chasing",
            "Enemy must return to 'chasing' when attack is evaded",
          );

          const logsEvade = await probe.logs();
          assert.ok(
            logsEvade.some((l) => l.message === "enemy.attackEvaded"),
            "Expected enemy.attackEvaded log event",
          );

          // --- Part B: Damage Trading & Hurt Reactions ---
          // Move back into attack range: player moves forward (-Z) to [-5, 0.5, -5]
          await probe.input({ action: "player.moveForward", phase: "press", value: 1 });
          await probe.step(1);

          // Step into telegraph
          const snapTelegraph2 = await probe.snapshot();
          assert.equal((snapTelegraph2.state.game as any)?.enemyState, "telegraph");

          // Player inputs attack to trade damage
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          const snapTrade = await probe.snapshot();
          assert.equal((snapTrade.state.game as any)?.enemyHealth, 2, "Enemy health must be 2 after hit");
          assert.equal((snapTrade.state.game as any)?.playerHealth, 2, "Player health must be 2 after trade");

          // Verify hurt feedback events in logs
          const logsTrade = await probe.logs();
          assert.ok(
            logsTrade.some((l) => l.message === "enemy.hurt"),
            "Expected enemy.hurt log event",
          );
          assert.ok(
            logsTrade.some((l) => l.message === "player.hurt"),
            "Expected player.hurt log event",
          );

          // Capture proof screenshot
          const frame = await probe.captureFrame();
          assertValidPng(frame, "Scenario 2 Evade and Trade");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 3: Encounter Progression — Defeating Enemy Unlocks Extraction
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 3: Defeating enemy unlocks extraction progression and allows run victory",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => {
            const proj = createArenaProject();
            const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
            (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
            return proj;
          },
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 503);

          // Initial check: extraction is locked/active
          const snapInit = await probe.snapshot();
          assert.equal((snapInit.state.game as any)?.encounter?.enemyDefeated, false);
          assert.equal((snapInit.state.game as any)?.encounter?.extractionUnlocked, false);

          // Attack 1: Player strikes (enemy HP 3 -> 2)
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          // Kite backward while enemy cooldown and player attack cooldown expire
          await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
          await probe.step(1);

          // Attack 2: Player strikes (enemy HP 2 -> 1)
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          // Kite backward again
          await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
          await probe.step(1);

          // Attack 3: Lethal strike (enemy HP 1 -> 0 -> Defeated)
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          const snapDefeated = await probe.snapshot();
          const game = snapDefeated.state.game as any;
          assert.equal(game.enemyHealth, 0);
          assert.equal(game.enemyState, "defeated");
          assert.equal(game.encounter.enemyDefeated, true, "Encounter enemyDefeated must be true");
          assert.equal(game.encounter.extractionUnlocked, true, "Encounter extractionUnlocked must be true");
          assert.equal(game.encounter.status, "defeated");

          const logs = await probe.logs();
          assert.ok(
            logs.some((l) => l.message === "gameplay.extractionUnlocked"),
            "Expected gameplay.extractionUnlocked log event",
          );

          // Player now navigates to Extraction Goal at [5, 0.1, -5]
          // Player is at x = -5, z = -3.
          // Move forward 2 steps to z = -5
          await probe.input({ action: "player.moveForward", phase: "hold", value: 1 });
          await probe.step(2);
          await probe.input({ action: "player.moveForward", phase: "release" });

          // Move right 10 steps to x = 5 (reaches goal at [5, 0.1, -5])
          await probe.input({ action: "player.moveRight", phase: "hold", value: 1 });
          await probe.step(10);
          await probe.input({ action: "player.moveRight", phase: "release" });

          const snapWin = await probe.snapshot();
          const gameWin = snapWin.state.game as any;
          assert.equal(gameWin.goalReached, true, "Goal must be reached");
          assert.equal(gameWin.status, "won", "Game status must be won");
          assert.equal(gameWin.run.status, "completed", "Run status must be completed");

          // Capture victory frame
          const frame = await probe.captureFrame();
          assertValidPng(frame, "Scenario 3 Encounter Victory");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 4: Run Statistics Tracking Across Actions
    // -----------------------------------------------------------------------
    await t.test("Scenario 4: Run summary statistics accumulate across combat and gameplay", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => {
          const proj = createArenaProject();
          const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
          (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
          return proj;
        },
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(ARENA_SCENE_ID, 504);

        // Player deals damage to enemy (damageDealt += 1)
        await probe.input({ action: "player.attack", phase: "press", value: 1 });
        await probe.step(1);

        // Enemy attacks player (damageTaken += 1)
        await probe.step(1);

        const snap1 = await probe.snapshot();
        const stats1 = (snap1.state.game as any)?.stats;
        assert.ok(stats1, "state.game.stats must exist");
        assert.equal(stats1.damageDealt, 1, "damageDealt must be 1");
        assert.equal(stats1.damageTaken, 1, "damageTaken must be 1");
        assert.ok(stats1.elapsedSteps >= 2, "elapsedSteps must be at least 2");
        assert.ok(stats1.elapsedTimeMs > 0, "elapsedTimeMs must be greater than 0");

        // Defeat enemy
        await probe.input({ action: "player.attack", phase: "press", value: 1 });
        await probe.step(1);
        await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
        await probe.step(1);
        await probe.input({ action: "player.attack", phase: "press", value: 1 });
        await probe.step(1);

        const snap2 = await probe.snapshot();
        const stats2 = (snap2.state.game as any)?.stats;
        assert.equal(stats2.damageDealt, 3, "damageDealt must be 3");
        assert.equal(stats2.enemiesDefeated, 1, "enemiesDefeated must be 1");

        // Verify gameplay.runSummary logged
        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message === "gameplay.runSummary" || l.message === "gameplay.extractionUnlocked"),
          "Expected gameplay.runSummary or extractionUnlocked log event",
        );
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 5: Multi-Process Save/Load of Combat Progression & Stats
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 5: Save/load round-trip across processes preserves combat progression and statistics",
      async () => {
        const saveDir = await mkdtemp(join(tmpdir(), "kinetra-progression-save-"));

        try {
          // --- Process A: Engage Combat, Track Stats, and Save ---
          const hostA = createArenaHost(saveDir);
          const probeA = new KinetraRuntimeProbe({
            host: hostA,
            project: () => {
              const proj = createArenaProject();
              const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
              (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
              return proj;
            },
            initialRevision: 0,
            assets: arenaAudioAssets,
            closeOnStop: false,
          });

          await probeA.start(ARENA_SCENE_ID, 505);

          // Step 1: Enemy telegraphs (player HP = 3, enemy HP = 3)
          await probeA.step(1);

          // Step 2: Trade damage (player HP = 2, enemy HP = 2)
          await probeA.input({ action: "player.attack", phase: "press", value: 1 });
          await probeA.step(1);

          const snapA = await probeA.snapshot();
          const gameA = snapA.state.game as any;
          assert.equal(gameA.playerHealth, 2);
          assert.equal(gameA.enemyHealth, 2);
          assert.equal(gameA.stats.damageDealt, 1);
          assert.equal(gameA.stats.damageTaken, 1);
          assert.equal(gameA.encounter.enemyDefeated, false);

          // Save during active encounter
          const saveResult = await probeA.captureSave("progression-slot");
          assert.equal(saveResult.success, true);

          await probeA.close();

          // --- Process B: Fresh Launch, Restore, and Complete Encounter ---
          const hostB = createArenaHost(saveDir);
          const probeB = new KinetraRuntimeProbe({
            host: hostB,
            project: () => {
              const proj = createArenaProject();
              const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
              (enemy.components.Transform as any).position = [-3.5, 0.5, -5];
              return proj;
            },
            initialRevision: 0,
            assets: arenaAudioAssets,
            closeOnStop: false,
          });

          try {
            await probeB.start(ARENA_SCENE_ID, 506);

            const loadResult = await probeB.loadSave({ slotId: "progression-slot" });
            assert.equal(loadResult.success, true);

            const snapB = await probeB.snapshot();
            const gameB = snapB.state.game as any;

            // Assert exact restoration of combat state & statistics
            assert.equal(gameB.playerHealth, 2, "Restored player health must be 2");
            assert.equal(gameB.enemyHealth, 2, "Restored enemy health must be 2");
            assert.equal(gameB.stats.damageDealt, 1, "Restored damageDealt must match saved value");
            assert.equal(gameB.stats.damageTaken, 1, "Restored damageTaken must match saved value");
            assert.equal(
              gameB.encounter.enemyDefeated,
              false,
              "Restored encounter.enemyDefeated must match saved value",
            );
            assert.equal(
              gameB.encounter.extractionUnlocked,
              false,
              "Restored encounter.extractionUnlocked must match saved value",
            );

            // Continue encounter in Process B: finish defeating enemy
            await probeB.input({ action: "player.moveBackward", phase: "press", value: 1 });
            await probeB.step(1);

            await probeB.input({ action: "player.attack", phase: "press", value: 1 });
            await probeB.step(1);

            await probeB.input({ action: "player.moveBackward", phase: "press", value: 1 });
            await probeB.step(1);

            await probeB.input({ action: "player.attack", phase: "press", value: 1 });
            await probeB.step(1);

            const snapBFinal = await probeB.snapshot();
            const gameBFinal = snapBFinal.state.game as any;
            assert.equal(gameBFinal.enemyHealth, 0, "Enemy must be defeated in Process B");
            assert.equal(gameBFinal.encounter.enemyDefeated, true, "Encounter enemyDefeated must be true");
            assert.equal(gameBFinal.encounter.extractionUnlocked, true, "Extraction must be unlocked");
            assert.equal(gameBFinal.stats.enemiesDefeated, 1, "enemiesDefeated must be 1");
          } finally {
            await probeB.close();
          }
        } finally {
          await rm(saveDir, { recursive: true, force: true });
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 6: Full Packaged Verification via AcceptanceManifest against KinetraGame.exe
    // -----------------------------------------------------------------------
    await t.test("Scenario 6: Full packaged verification of combat progression against runtime", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => {
          const proj = createArenaProject();
          const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
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
          suite: "arena-combat-progression-packaged",
          seed: 507,
          target: process.env.KINETRA_RUNTIME_EXECUTABLE ? "packaged" : "runtime",
          steps: [
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "assert.equal", path: "running", expected: true },
            { type: "assert.equal", path: "state.game.status", expected: "playing" },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
            { type: "assert.equal", path: "state.game.enemyHealth", expected: 3 },
            // Step 1: Enemy telegraphs attack
            { type: "runtime.step", steps: 1 },
            { type: "assert.equal", path: "state.game.enemyState", expected: "telegraph" },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
            // Step 2: Player attacks and trades damage
            { type: "input", action: "player.attack", phase: "press", value: 1 },
            { type: "runtime.step", steps: 1 },
            { type: "assert.equal", path: "state.game.enemyHealth", expected: 2 },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 2 },
            { type: "assert.screenshotValidPng" },
            { type: "runtime.stop" },
          ],
        };

        const runner = new AcceptanceRunner(probe);
        const report = await runner.run(manifest);
        assert.equal(report.passed, true, `Combat progression manifest failed: ${report.failureReason}`);

        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message === "enemy.attackTelegraph"),
          "Expected enemy.attackTelegraph log event in packaged combat progression",
        );
      } finally {
        await probe.close();
      }
    });
  },
);
