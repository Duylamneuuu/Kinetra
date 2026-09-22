import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
  ARENA_SFX_HIT_ASSET_ID,
  ARENA_ENTITY_PLAYER,
  ARENA_ENTITY_ENEMY,
  ARENA_ENTITY_MANAGER,
} from "@kinetra/reference-game";
import {
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";
import { devElectronRuntimeSupported } from "../src/index.js";

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
  "Combat Foundation Slice 4 — Player Attack, Damage Model, Enemy Defeated State, Multi-Process Save/Load, Packaged Proof",
  { skip: !devElectronRuntimeSupported(), timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Scenario 1: Player attacks Enemy, Enemy health decreases
    // -----------------------------------------------------------------------
    await t.test("Scenario 1: Player attacks enemy and decreases enemy health", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => {
          // Place enemy within player attackRange (2.0m):
          // Player at [-5, 0.5, -5], Enemy placed at [-3.5, 0.5, -5] (dist = 1.5)
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
        await probe.start(ARENA_SCENE_ID, 401);
        const snapInit = await probe.snapshot();
        assert.equal((snapInit.state.game as any)?.playerHealth, 3);
        assert.equal((snapInit.state.game as any)?.enemyHealth, 3);

        // Player executes semantic attack action
        await probe.input({ action: "player.attack", phase: "press", value: 1 });
        await probe.step(1);

        const snapPost = await probe.snapshot();
        // Enemy health decreased from 3 to 2
        assert.equal((snapPost.state.game as any)?.enemyHealth, 2);

        // Check player script state: cooldown initiated and lastAction recorded
        const playerEntity = (snapPost.state.byName as any)["Player"];
        assert.equal(playerEntity.gameplay?.state?.attackCooldown, 2);
        assert.equal(playerEntity.gameplay?.state?.lastAction, "player.attack");

        // Verify combat events and audio evidence in logs
        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message === "player.attackHit"),
          "Expected player.attackHit log event",
        );
        assert.ok(
          logs.some((l) => l.message === "gameplay.enemyDamaged"),
          "Expected gameplay.enemyDamaged log event",
        );
        assert.ok(
          logs.some(
            (l) =>
              l.message === "audio.played" &&
              l.data?.assetId === ARENA_SFX_HIT_ASSET_ID &&
              l.data?.bus === "sfx",
          ),
          "Expected audio.played log event for hit sound on sfx bus",
        );

        // Capture proof screenshot
        const frame = await probe.captureFrame();
        assertValidPng(frame, "Scenario 1 Player Attack");
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 2: Enemy attacks Player, Player health decreases
    // -----------------------------------------------------------------------
    await t.test("Scenario 2: Enemy attacks player and decreases player health", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => {
          // Place enemy within attackRange (1.6m):
          // Player at [-5, 0.5, -5], Enemy placed at [-3.5, 0.5, -5] (dist = 1.5)
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
        await probe.start(ARENA_SCENE_ID, 402);
        const snapInit = await probe.snapshot();
        assert.equal((snapInit.state.game as any)?.playerHealth, 3);

        // Advance 1 step without player attacking: enemy attacks player
        await probe.step(1);

        const snapPost = await probe.snapshot();
        // Player health decreased from 3 to 2
        assert.equal((snapPost.state.game as any)?.playerHealth, 2);

        // Verify combat logs
        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message === "enemy.attack"),
          "Expected enemy.attack log event",
        );
        assert.ok(
          logs.some((l) => l.message === "gameplay.playerDamaged"),
          "Expected gameplay.playerDamaged log event",
        );

        // Capture proof screenshot
        const frame = await probe.captureFrame();
        assertValidPng(frame, "Scenario 2 Enemy Attack");
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 3: Enemy reaches zero HP, enters defeated state, and navigation stops
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 3: Enemy reaches zero HP, enters defeated state, and navigation stops",
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
          await probe.start(ARENA_SCENE_ID, 403);

          // Attack 1: HP 3 -> 2
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);
          const snap1 = await probe.snapshot();
          assert.equal((snap1.state.game as any)?.enemyHealth, 2);

          // Move backward to kite enemy using range advantage (attackRange 2.0m vs enemy 1.6m)
          await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
          await probe.step(1);

          // Attack 2: HP 2 -> 1
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);
          const snap2 = await probe.snapshot();
          assert.equal((snap2.state.game as any)?.enemyHealth, 1);

          // Move backward to kite enemy again
          await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
          await probe.step(1);

          // Attack 3: HP 1 -> 0 -> Defeated!
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          const snapDefeated = await probe.snapshot();
          assert.equal((snapDefeated.state.game as any)?.enemyHealth, 0);
          assert.equal((snapDefeated.state.game as any)?.enemyState, "defeated");

          const enemyEntity = (snapDefeated.state.byName as any)["Enemy"];
          assert.equal(enemyEntity.gameplay?.state?.health, 0);
          assert.equal(enemyEntity.gameplay?.state?.state, "defeated");

          // Verify defeat logs
          const logs = await probe.logs();
          assert.ok(
            logs.some((l) => l.message === "gameplay.enemyDefeated"),
            "Expected gameplay.enemyDefeated log event",
          );

          // Record defeated enemy position
          const defeatedPos: [number, number, number] = [
            Number(enemyEntity.position[0]),
            Number(enemyEntity.position[1]),
            Number(enemyEntity.position[2]),
          ];

          // Advance 5 steps while Player moves away
          await probe.input({ action: "player.moveBackward", phase: "hold", value: 1 });
          await probe.step(5);
          await probe.input({ action: "player.moveBackward", phase: "release" });

          // Verify enemy did NOT move at all (navigation halted)
          const snapAfter = await probe.snapshot();
          const enemyAfter = (snapAfter.state.byName as any)["Enemy"];
          assert.equal(enemyAfter.position[0], defeatedPos[0], "Defeated enemy X position must be frozen");
          assert.equal(enemyAfter.position[1], defeatedPos[1], "Defeated enemy Y position must be frozen");
          assert.equal(enemyAfter.position[2], defeatedPos[2], "Defeated enemy Z position must be frozen");

          // Capture proof screenshot
          const frame = await probe.captureFrame();
          assertValidPng(frame, "Scenario 3 Enemy Defeated");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 4: Save/load during combat restores player HP, enemy HP, enemy state, cooldown
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 4: Save/load during combat restores player HP, enemy HP, enemy state, and cooldown",
      async () => {
        const saveDir = await mkdtemp(join(tmpdir(), "kinetra-combat-save-"));

        try {
          // --- Process A: Combat & Save ---
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

          await probeA.start(ARENA_SCENE_ID, 404);

          // Step 1: Enemy attacks player (player HP 3 -> 2)
          await probeA.step(1);

          // Step 2: Player attacks enemy (enemy HP 3 -> 2, player attackCooldown = 2)
          await probeA.input({ action: "player.attack", phase: "press", value: 1 });
          await probeA.step(1);

          const snapA = await probeA.snapshot();
          assert.equal((snapA.state.game as any)?.playerHealth, 2);
          assert.equal((snapA.state.game as any)?.enemyHealth, 2);

          const playerA = (snapA.state.byName as any)["Player"];
          const enemyA = (snapA.state.byName as any)["Enemy"];
          assert.equal(playerA.gameplay?.state?.attackCooldown, 2);
          const enemyStateA = enemyA.gameplay?.state?.state;

          // Save during active combat
          const saveResult = await probeA.captureSave("combat-progress");
          assert.equal(saveResult.success, true);

          await probeA.close();

          // --- Process B: Fresh Launch & Restore ---
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
            await probeB.start(ARENA_SCENE_ID, 405);

            // Restore combat save slot
            const loadResult = await probeB.loadSave({ slotId: "combat-progress" });
            assert.equal(loadResult.success, true);

            // Invariant assertions: player HP, enemy HP, enemy state, cooldown restored
            const snapB = await probeB.snapshot();
            assert.equal((snapB.state.game as any)?.playerHealth, 2, "Restored player health must be 2");
            assert.equal((snapB.state.game as any)?.enemyHealth, 2, "Restored enemy health must be 2");

            const playerB = (snapB.state.byName as any)["Player"];
            const enemyB = (snapB.state.byName as any)["Enemy"];
            assert.equal(
              playerB.gameplay?.state?.attackCooldown,
              2,
              "Restored attackCooldown must match saved cooldown",
            );
            assert.equal(
              enemyB.gameplay?.state?.state,
              enemyStateA,
              "Restored enemy state must match saved state",
            );

            // Move backward to maintain range advantage while attack cooldown expires
            await probeB.input({ action: "player.moveBackward", phase: "press", value: 1 });
            await probeB.step(1);

            // Player attacks enemy again in Process B (enemy HP 2 -> 1)
            await probeB.input({ action: "player.attack", phase: "press", value: 1 });
            await probeB.step(1);

            const snapB2 = await probeB.snapshot();
            assert.equal((snapB2.state.game as any)?.enemyHealth, 1, "Enemy health must decrease to 1 in Process B");
          } finally {
            await probeB.close();
          }
        } finally {
          await rm(saveDir, { recursive: true, force: true });
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 5: Full packaged verification against KinetraGame.exe
    // -----------------------------------------------------------------------
    await t.test("Scenario 5: Full packaged verification of combat against runtime", async () => {
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
          suite: "arena-combat-packaged",
          seed: 405,
          target: process.env.KINETRA_RUNTIME_EXECUTABLE ? "packaged" : "runtime",
          steps: [
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "assert.equal", path: "running", expected: true },
            { type: "assert.equal", path: "state.game.status", expected: "playing" },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
            { type: "assert.equal", path: "state.game.enemyHealth", expected: 3 },
            // Player attacks enemy
            { type: "input", action: "player.attack", phase: "press", value: 1 },
            { type: "runtime.step", steps: 1 },
            { type: "assert.equal", path: "state.game.enemyHealth", expected: 2 },
            // Enemy attacks player
            { type: "runtime.step", steps: 1 },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 2 },
            { type: "assert.screenshotValidPng" },
            { type: "runtime.stop" },
          ],
        };

        const runner = new AcceptanceRunner(probe);
        const report = await runner.run(manifest);
        assert.equal(report.passed, true, `Combat manifest failed: ${report.failureReason}`);

        const logs = await probe.logs();
        assert.ok(
          logs.some((l) => l.message === "player.attackHit"),
          "Expected player.attackHit log event in packaged combat",
        );
      } finally {
        await probe.close();
      }
    });
  },
);
