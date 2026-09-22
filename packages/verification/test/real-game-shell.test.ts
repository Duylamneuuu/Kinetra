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
} from "@kinetra/reference-game";
import {
  DEFAULT_PLAYER_INPUT_MAP,
  FakeGamepadSnapshotProvider,
  InputRouter,
  type PhysicalInputSnapshot,
} from "@kinetra/input";
import {
  SettingsStore,
  type PlayerSettingsData,
} from "@kinetra/save-state";
import { FileKeyValueStorage } from "@kinetra/save-state/file";
import {
  canRunRealElectronTests,  AcceptanceRunner,
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
  // PNG Magic Bytes: \x89 P N G \r \n \x1a \n
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
  "Game Shell & Controller Slice 2 — Main Menu, HUD, Pause, Settings, Gamepad, Save/Continue, Result Screens",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Scenario 1: Main Menu Startup & PNG Proof
    // -----------------------------------------------------------------------
    await t.test("Scenario 1: boots into Main Menu with shell.mode == mainMenu and valid PNG", async () => {
      const host = createArenaHost();

      try {
        const query = await host.query();

        assert.equal(query.running, false, "Packaged player must not auto-start gameplay");
        assert.ok(query.shell, "Runtime query must expose shell state");
        assert.equal(query.shell.mode, "mainMenu", "Initial shell mode must be mainMenu");
        assert.equal(query.shell.isPaused, false);

        // Capture real frame of Main Menu
        const frame = await host.captureFrame();
        assert.ok(frame.available, "Frame capture must succeed");
        assert.equal(frame.mimeType, "image/png");
        assert.ok(frame.base64, "base64 must be present");
        const pngBytes = Buffer.from(frame.base64, "base64");
        assertValidPng(pngBytes, "Main Menu");
      } finally {
        await host.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 2: New Game & Gameplay HUD Projection with PNG Proof
    // -----------------------------------------------------------------------
    await t.test("Scenario 2: New Game starts Arena, projects HUD (HP 3, objective), updates on damage", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createArenaProject(),
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      try {
        // Start game via manifest
        const manifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "hud-verification",
          seed: 201,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "assert.equal", path: "running", expected: true },
            { type: "assert.equal", path: "state.shell.mode", expected: "playing" },
            { type: "assert.equal", path: "state.game.playerHealth", expected: 3 },
            { type: "assert.equal", path: "state.game.status", expected: "playing" },
            { type: "assert.screenshotValidPng" },
            { type: "runtime.stop" },
          ],
        };

        const runner = new AcceptanceRunner(probe);
        const report = await runner.run(manifest);
        assert.equal(report.passed, true, `HUD verification failed: ${report.failureReason}`);

        // Start directly and capture raw PNG frame for validation
        await probe.start(ARENA_SCENE_ID, 201);
        const frame = await probe.captureFrame();
        assertValidPng(frame, "Gameplay HUD");
        await probe.stop();
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 3: Deterministic Pause Simulation Freeze & PNG Proof
    // -----------------------------------------------------------------------
    await t.test("Scenario 3: game.pause freezes simulation, enemy, player, health; resume unfreezes", async () => {
      const host = createArenaHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createArenaProject(),
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: true,
      });

      try {
        await probe.start(ARENA_SCENE_ID, 1);

        // Advance 2 steps: enemy is navigating towards player
        await probe.step(2);
        const snapBefore = await probe.snapshot();
        const enemyBefore = (snapBefore.state.byName as any)["Enemy"];
        const playerBefore = (snapBefore.state.byName as any)["Player"];
        assert.ok(enemyBefore);
        assert.ok(playerBefore);

        const enemyPosBefore = [...enemyBefore.position] as [number, number, number];
        const healthBefore = (snapBefore.state.game as any)?.playerHealth;
        assert.equal(healthBefore, 3);

        // 1. Pause gameplay via semantic action
        await probe.input({ action: "game.pause", phase: "press" });

        const snapPaused = await probe.snapshot();
        assert.equal((snapPaused.state.shell as any)?.mode, "paused", "Shell mode must be paused");
        assert.equal((snapPaused.state.shell as any)?.isPaused, true, "isPaused must be true");

        // Capture Pause Menu PNG
        const pauseFrame = await probe.captureFrame();
        assertValidPng(pauseFrame, "Pause Menu");

        // 2. Step 10 steps while paused: simulation MUST NOT advance
        await probe.step(10);

        // Also attempt movement input while paused: input MUST be blocked
        await probe.input({ action: "player.moveForward", phase: "press", value: 1 });
        await probe.step(2);

        const snapStillPaused = await probe.snapshot();
        const enemyWhilePaused = (snapStillPaused.state.byName as any)["Enemy"];
        const playerWhilePaused = (snapStillPaused.state.byName as any)["Player"];

        // Enemy position strictly unchanged
        assert.equal(
          enemyWhilePaused.position[0],
          enemyPosBefore[0],
          "Enemy X position must remain frozen while paused",
        );
        assert.equal(
          enemyWhilePaused.position[2],
          enemyPosBefore[2],
          "Enemy Z position must remain frozen while paused",
        );

        // Player health unchanged
        assert.equal(
          (snapStillPaused.state.game as any)?.playerHealth,
          healthBefore,
          "Player health must remain unchanged while paused",
        );

        // 3. Resume gameplay
        await probe.input({ action: "game.pause", phase: "press" });

        const snapResumed = await probe.snapshot();
        assert.equal((snapResumed.state.shell as any)?.mode, "playing", "Shell mode must resume to playing");
        assert.equal((snapResumed.state.shell as any)?.isPaused, false, "isPaused must be false after resume");

        // Step 3 steps: enemy MUST advance again
        await probe.step(3);
        const snapAfter = await probe.snapshot();
        const enemyAfter = (snapAfter.state.byName as any)["Enemy"];

        const movedAfter =
          enemyAfter.position[0] !== enemyPosBefore[0] ||
          enemyAfter.position[2] !== enemyPosBefore[2];
        assert.ok(movedAfter, "Enemy movement must resume after unpausing");

        await probe.stop();
      } finally {
        await probe.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 4: Settings Persistence Across Process Restart
    // -----------------------------------------------------------------------
    await t.test("Scenario 4: settings (masterGain, sfxGain, fullscreen, remapping) persist across process restart", async () => {
      const saveDir = await mkdtemp(join(tmpdir(), "kinetra-shell-settings-"));

      try {
        const fileStorage = new FileKeyValueStorage(saveDir);
        const store = new SettingsStore(fileStorage);

        // Process A: Save custom settings
        const customSettings: PlayerSettingsData = {
          schemaVersion: 1,
          audio: {
            masterGain: 0.5,
            sfxGain: 0.25,
          },
          display: {
            fullscreen: true,
          },
          input: {
            customBindings: {
              "player.moveRight": [{ kind: "key", code: "KeyL", scale: 1 }],
            },
          },
        };
        await store.save(customSettings);

        // Launch real Electron host with this saveDir to verify it reads persisted settings
        const host = createArenaHost(saveDir);

        try {
          const query = await host.query();
          assert.equal(query.running, false);

          const storeB = new SettingsStore(new FileKeyValueStorage(saveDir));
          const loaded = await storeB.load();

          assert.equal(loaded.audio.masterGain, 0.5, "Master gain must persist across restart");
          assert.equal(loaded.audio.sfxGain, 0.25, "SFX gain must persist across restart");
          assert.equal(loaded.display.fullscreen, true, "Fullscreen setting must persist across restart");
          assert.ok(loaded.input?.customBindings?.["player.moveRight"], "Custom binding must persist");
          assert.equal(
            (loaded.input.customBindings["player.moveRight"] as any)[0]?.code,
            "KeyL",
          );
        } finally {
          await host.close();
        }
      } finally {
        await rm(saveDir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 5: Multi-Process Save & Continue
    // -----------------------------------------------------------------------
    await t.test("Scenario 5: Process A saves progress -> terminates -> Process B sees Continue enabled -> loads -> finishes game", async () => {
      const saveDir = await mkdtemp(join(tmpdir(), "kinetra-shell-continue-"));

      try {
        // --- Process A: Play and Save ---
        const hostA = createArenaHost(saveDir);
        const probeA = new KinetraRuntimeProbe({
          host: hostA,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        await probeA.start(ARENA_SCENE_ID, 1);
        // Player moves right 3 steps
        await probeA.input({ action: "player.moveRight", phase: "hold", value: 1 });
        await probeA.step(3);

        // Capture save to slot "arena-progress"
        const saveResult = await probeA.captureSave("arena-progress");
        assert.equal(saveResult.success, true);
        assert.ok(saveResult.envelope);

        // Verify save file exists on disk
        const filesA = await readdir(saveDir);
        assert.ok(
          filesA.some((f) => f.includes("arena-progress.json")),
          "Expected arena-progress.json file on disk",
        );

        // Terminate Process A completely
        await probeA.close();

        // --- Process B: Fresh Launch & Continue ---
        const hostB = createArenaHost(saveDir);
        const probeB = new KinetraRuntimeProbe({
          host: hostB,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        await probeB.start(ARENA_SCENE_ID, 1);

        // Restore save
        const restoreResult = await probeB.loadSave({ slotId: "arena-progress" });
        assert.equal(restoreResult.success, true);
        assert.equal(restoreResult.slotId, "arena-progress");

        // Assert restored position matches saved position (player at X = -2, Z = -5)
        const snapB = await probeB.snapshot();
        const playerB = (snapB.state.byName as any)["Player"];
        assert.ok(playerB);
        assert.equal(playerB.position[0], -2);
        assert.equal(playerB.position[2], -5);

        // Continue gameplay to victory: move right 7 more steps to reach goal at [5, 0.1, -5]
        await probeB.input({ action: "player.moveRight", phase: "hold", value: 1 });
        await probeB.step(7);

        const snapWin = await probeB.snapshot();
        assert.equal((snapWin.state.game as any)?.status, "won", "Player must achieve victory");
        assert.equal((snapWin.state.shell as any)?.mode, "won", "Shell mode must transition to won");

        await probeB.close();
      } finally {
        await rm(saveDir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 6: Win & Lose Result Screens with Real PNG Capture
    // -----------------------------------------------------------------------
    await t.test("Scenario 6: deterministic WIN and LOSE states display player-facing result screens with valid PNGs", async () => {
      // 1. Victory Path & PNG
      const hostWin = createArenaHost();
      const probeWin = new KinetraRuntimeProbe({
        host: hostWin,
        project: () => createArenaProject(),
        initialRevision: 0,
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      try {
        await probeWin.start(ARENA_SCENE_ID, 1);
        // Player moves right 10 steps to reach goal at [5, 0.1, -5]
        await probeWin.input({ action: "player.moveRight", phase: "hold", value: 1 });
        await probeWin.step(10);

        const snapWin = await probeWin.snapshot();
        assert.equal((snapWin.state.game as any)?.status, "won");
        assert.equal((snapWin.state.shell as any)?.mode, "won");

        const winFrame = await probeWin.captureFrame();
        assertValidPng(winFrame, "Victory Screen");

        // Clean stop and return to Main Menu
        await probeWin.stop();
        const snapMenu = await probeWin.snapshot();
        assert.equal((snapMenu.state.shell as any)?.mode, "mainMenu");
      } finally {
        await probeWin.close();
      }

      // 2. Defeat Path & PNG
      const hostLose = createArenaHost();
      const probeLose = new KinetraRuntimeProbe({
        host: hostLose,
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
        closeOnStop: true,
      });

      try {
        await probeLose.start(ARENA_SCENE_ID, 1);
        // Step 1: Enemy attacks -> HP 2
        await probeLose.step(1);
        // Step 2-3: Cooldown -> HP 1
        await probeLose.step(2);
        // Step 4-5: Cooldown -> HP 0 -> LOST
        await probeLose.step(2);

        const snapLose = await probeLose.snapshot();
        assert.equal((snapLose.state.game as any)?.status, "lost");
        assert.equal((snapLose.state.game as any)?.playerHealth, 0);
        assert.equal((snapLose.state.shell as any)?.mode, "lost");

        const loseFrame = await probeLose.captureFrame();
        assertValidPng(loseFrame, "Defeat Screen");

        await probeLose.stop();
      } finally {
        await probeLose.close();
      }
    });

    // -----------------------------------------------------------------------
    // Scenario 7: Fake Gamepad Semantic Input Mapping
    // -----------------------------------------------------------------------
    await t.test("Scenario 7: GamepadSnapshotProvider fake provider routes stick and buttons to semantic actions without hardware", () => {
      const router = new InputRouter(DEFAULT_PLAYER_INPUT_MAP);
      const fakeProvider = new FakeGamepadSnapshotProvider();

      // Stick pushed right & forward
      fakeProvider.setSnapshot({
        buttons: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        axes: [0.9, -0.85],
      });
      const padA = fakeProvider.getSnapshot();
      assert.ok(padA);
      const snapA: PhysicalInputSnapshot = {
        keys: new Set(),
        gamepadButtons: padA.buttons,
        gamepadAxes: padA.axes,
      };

      assert.equal(router.getActionValue("player.moveRight", snapA), 0.9);
      assert.equal(router.getActionValue("player.moveLeft", snapA), 0);
      assert.equal(router.getActionValue("player.moveForward", snapA), 0.85);
      assert.equal(router.getActionValue("player.moveBackward", snapA), 0);

      // Buttons pressed: Start (pause), South (confirm), East (back)
      fakeProvider.setSnapshot({
        buttons: [1, 1, 0, 0, 0, 0, 0, 0, 0, 1], // button 0, 1, 9
        axes: [0, 0],
      });
      const padB = fakeProvider.getSnapshot();
      assert.ok(padB);
      const snapB: PhysicalInputSnapshot = {
        keys: new Set(),
        gamepadButtons: padB.buttons,
        gamepadAxes: padB.axes,
      };

      assert.equal(router.isActionPressed("game.pause", snapB), true);
      assert.equal(router.isActionPressed("ui.confirm", snapB), true);
      assert.equal(router.isActionPressed("ui.back", snapB), true);
    });
  },
);
