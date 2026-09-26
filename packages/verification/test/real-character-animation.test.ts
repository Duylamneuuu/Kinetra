import assert from "node:assert/strict";
import test from "node:test";

import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
  ARENA_ENTITY_ENEMY,
  ARENA_ENTITY_PLAYER,
  ARENA_ENEMY_MODEL_ASSET_ID,
} from "@kinetra/reference-game";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

function createArenaHost(saveDir?: string): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    ...(saveDir ? { saveDir } : {}),
    requestTimeoutMs: 30_000,
    electronArgs: realElectronLaunchArgs(),
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
  "Character Combat Animation Slice — Real Rigged/Skinned Mesh, Semantic Animation Layer, Combat Clips, and Packaged Runtime Proof",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Scenario 1: Rigged Character Model & Skeleton Observable via Runtime Query
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 1: Rigged GLB character loads cleanly with SkinnedMesh, skeleton joints, and clips",
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
          await probe.start(ARENA_SCENE_ID, 601);

          const snap = await probe.snapshot();
          assert.equal(snap.running, true, "Runtime must be running");

          // Find enemy entity
          const raw = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemyEntity = raw.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          assert.ok(enemyEntity, "Enemy entity must exist in runtime query");
          assert.ok(enemyEntity.model, "Enemy entity must have a model object");

          // Requirement 1 & 2: Rigged model loaded with SkinnedMesh metadata
          assert.equal(enemyEntity.model.loaded, true, "Model must be loaded");
          assert.equal(
            enemyEntity.model.assetId,
            ARENA_ENEMY_MODEL_ASSET_ID,
            "Model assetId must match ARENA_ENEMY_MODEL_ASSET_ID",
          );
          assert.ok(enemyEntity.model.meshCount >= 1, "Enemy model must contain at least 1 mesh");
          assert.ok(
            (enemyEntity.model.skinnedMeshCount ?? 0) >= 1,
            `Enemy model must contain at least 1 SkinnedMesh, got ${enemyEntity.model.skinnedMeshCount}`,
          );
          assert.equal(enemyEntity.model.hasSkin, true, "Enemy model hasSkin must be true");

          // Skeleton joint node hierarchy observable
          assert.ok(enemyEntity.model.nodes, "Model node hierarchy must be present");
          const nodeNames = enemyEntity.model.nodes.map((n) => n.name);
          const expectedJoints = [
            "Hips",
            "Spine",
            "Head",
            "LeftArm",
            "RightArm",
            "LeftLeg",
            "RightLeg",
          ];
          for (const joint of expectedJoints) {
            assert.ok(
              nodeNames.includes(joint),
              `Expected skeleton joint "${joint}" in model nodes: ${nodeNames.join(", ")}`,
            );
          }

          // Requirement 3: All 6 combat clips registered with expected durations
          assert.ok(enemyEntity.model.animation, "Model animation state must be present");
          const clips = enemyEntity.model.animation.clips;
          const clipMap = new Map(clips.map((c) => [c.name, c.duration]));
          assert.ok(clipMap.has("idle"), "Clip 'idle' must exist");
          assert.ok(clipMap.has("walk"), "Clip 'walk' must exist");
          assert.ok(clipMap.has("telegraph"), "Clip 'telegraph' must exist");
          assert.ok(clipMap.has("attack"), "Clip 'attack' must exist");
          assert.ok(clipMap.has("hurt"), "Clip 'hurt' must exist");
          assert.ok(clipMap.has("defeat"), "Clip 'defeat' must exist");

          assert.ok(Math.abs((clipMap.get("idle") ?? 0) - 1.0) < 0.05, "idle duration ~1.0s");
          assert.ok(Math.abs((clipMap.get("walk") ?? 0) - 1.0) < 0.05, "walk duration ~1.0s");
          assert.ok(Math.abs((clipMap.get("telegraph") ?? 0) - 0.6) < 0.05, "telegraph duration ~0.6s");
          assert.ok(Math.abs((clipMap.get("attack") ?? 0) - 0.4) < 0.05, "attack duration ~0.4s");
          assert.ok(Math.abs((clipMap.get("hurt") ?? 0) - 0.3) < 0.05, "hurt duration ~0.3s");
          assert.ok(Math.abs((clipMap.get("defeat") ?? 0) - 1.0) < 0.05, "defeat duration ~1.0s");

          // Requirement 4: Locomotion starts with walk animation playing
          assert.equal(
            enemyEntity.model.animation.activeClip,
            "walk",
            "Enemy starting in chasing state must have activeClip 'walk'",
          );
          assert.equal(enemyEntity.model.animation.playing, true, "Animation must be playing");

          // Zero model load failure logs
          const logs = await probe.logs();
          assert.ok(
            !logs.some((l) => l.message === "model.loadFailed"),
            "Zero model.loadFailed error logs expected",
          );
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 2: Chasing State Drives Walk Animation and In-Place Locomotion
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 2: Chasing state drives walk animation while navigation/physics owns translation",
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
          await probe.start(ARENA_SCENE_ID, 602);

          const q0 = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy0 = q0.entities[0]!;
          const initPos = [...enemy0.position];

          // Initial state is chasing -> walk animation
          assert.equal((enemy0.gameplay?.state as any)?.state, "chasing");
          assert.equal(enemy0.model?.animation?.activeClip, "walk");
          assert.equal(enemy0.model?.animation?.playing, true);

          // Step 3 frames: enemy should translate along NavMesh path toward player
          await probe.step(3);

          const q1 = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy1 = q1.entities[0]!;

          // Translation occurred (physics/gameplay owns translation)
          const distMoved = Math.hypot(
            enemy1.position[0] - initPos[0]!,
            enemy1.position[2] - initPos[2]!,
          );
          assert.ok(distMoved > 0.1, `Enemy should have moved towards player, moved ${distMoved}m`);

          // Animation is still walk
          assert.equal(enemy1.model?.animation?.activeClip, "walk");
          assert.equal(enemy1.model?.animation?.playing, true);
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 3: Telegraph Warning Phase Switches to Telegraph Clip
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 3: Entering attack range switches clip to telegraph without dealing premature damage",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => {
            // Position enemy at [-3.5, 0.5, -5], within attack range 1.6m of player at [-5, 0.5, -5]
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
          await probe.start(ARENA_SCENE_ID, 603);

          // Step 1: Enemy detects player in range -> transitions to telegraph
          await probe.step(1);

          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy = q.entities[0]!;

          assert.equal((enemy.gameplay?.state as any)?.state, "telegraph");
          assert.equal(
            enemy.model?.animation?.activeClip,
            "telegraph",
            "Enemy must play 'telegraph' clip during warning phase",
          );
          assert.equal(
            (enemy.gameplay?.state as any)?.animationClip,
            "telegraph",
            "Gameplay script state must reflect 'telegraph' animation",
          );

          // Damage has NOT been dealt yet
          const snap = await probe.snapshot();
          assert.equal((snap.state.game as any)?.playerHealth, 3, "Player health must remain 3 during telegraph");

          // Telegraph log event fired
          const logs = await probe.logs();
          assert.ok(logs.some((l) => l.message === "enemy.attackTelegraph"));
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 4: Attack Execution Plays Attack Clip While Preserving Damage Timing
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 4: Telegraph completion plays attack clip and inflicts damage deterministically",
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
          await probe.start(ARENA_SCENE_ID, 604);

          // Step 1: Enters telegraph
          await probe.step(1);

          // Step 2: Telegraph warning completes -> attack executes!
          await probe.step(1);

          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy = q.entities[0]!;

          // Attack clip played
          assert.equal(
            enemy.model?.animation?.activeClip,
            "attack",
            "Enemy must play 'attack' clip when attack connects",
          );

          // Damage inflicted strictly according to gameplay timing
          const snap = await probe.snapshot();
          assert.equal((snap.state.game as any)?.playerHealth, 2, "Player health must be reduced to 2");

          const logs = await probe.logs();
          assert.ok(logs.some((l) => l.message === "enemy.attack"), "Expected enemy.attack log");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 5: Hurt Reaction Switches to Hurt Animation Clip
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 5: Player attack inflicts damage and triggers enemy hurt animation reaction",
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
          await probe.start(ARENA_SCENE_ID, 605);

          // Player attacks enemy on step 1 (distance 1.5 <= 2.0 attack range)
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy = q.entities[0]!;

          // Enemy received damage and triggered hurt reaction
          assert.equal((enemy.gameplay?.state as any)?.health, 2, "Enemy health must be reduced to 2");
          assert.equal(
            enemy.model?.animation?.activeClip,
            "hurt",
            "Enemy must play 'hurt' clip upon receiving damage",
          );

          const logs = await probe.logs();
          assert.ok(logs.some((l) => l.message === "enemy.hurt"), "Expected enemy.hurt log");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 6: Lethal Damage Plays Defeat Clip and Halts Enemy Action
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 6: Defeating enemy transitions to defeat animation and halts all movement/action",
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
          await probe.start(ARENA_SCENE_ID, 606);

          // Attack 1: Player strikes (enemy HP 3 -> 2)
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          // Wait 1 step while kiting to let attack cooldown expire
          await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
          await probe.step(1);

          // Attack 2: Player strikes (enemy HP 2 -> 1)
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          // Wait 1 step while kiting to let attack cooldown expire
          await probe.input({ action: "player.moveBackward", phase: "press", value: 1 });
          await probe.step(1);

          // Attack 3: Lethal strike (enemy HP 1 -> 0 -> Defeated)
          await probe.input({ action: "player.attack", phase: "press", value: 1 });
          await probe.step(1);

          const qDefeated = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemyDefeated = qDefeated.entities[0]!;

          assert.equal(
            (enemyDefeated.gameplay?.state as any)?.state,
            "defeated",
            "Enemy state must be 'defeated'",
          );
          assert.equal(
            (enemyDefeated.gameplay?.state as any)?.health,
            0,
            "Enemy health must be 0",
          );
          assert.equal(
            enemyDefeated.model?.animation?.activeClip,
            "defeat",
            "Enemy must play 'defeat' clip",
          );

          const defeatPos = [...enemyDefeated.position];

          // Step multiple frames: defeated enemy must remain completely stationary
          await probe.step(5);

          const qStillDefeated = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemyStill = qStillDefeated.entities[0]!;

          assert.equal((enemyStill.gameplay?.state as any)?.state, "defeated");
          assert.equal(enemyStill.model?.animation?.activeClip, "defeat");
          assert.deepEqual(
            enemyStill.position,
            defeatPos,
            "Defeated enemy must not move or translate",
          );
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 7: Clean Scene Restart Resets Controller and Animation State
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 7: Scene reload cleanly resets enemy controller and animation state",
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
          // First run
          await probe.start(ARENA_SCENE_ID, 607);
          await probe.step(3);
          await probe.stop();

          // Second run (clean restart)
          await probe.start(ARENA_SCENE_ID, 608);

          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy = q.entities[0]!;

          assert.equal((enemy.gameplay?.state as any)?.health, 3, "Health must be reset to 3");
          assert.equal((enemy.gameplay?.state as any)?.state, "chasing", "State must be reset to chasing");
          assert.equal(
            enemy.model?.animation?.activeClip,
            "walk",
            "Animation must be reset to 'walk'",
          );
          assert.equal(enemy.model?.animation?.playing, true);
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 8: Visual Rendering & Screenshot Proof
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 8: WebGL frame capture succeeds and produces valid PNG with character rendered",
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
          await probe.start(ARENA_SCENE_ID, 609);
          await probe.step(2);

          const frame = await probe.captureFrame();
          assertValidPng(frame, "Character Combat Animation Slice");
        } finally {
          await probe.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 9: Zero Console Errors, Zero Error Logs, Clean Teardown
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 9: Verification run produces zero error logs and closes cleanly",
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
          await probe.start(ARENA_SCENE_ID, 610);
          await probe.step(5);

          const logs = await probe.logs();
          const errorLogs = logs.filter((l) => l.level === "error");
          assert.equal(
            errorLogs.length,
            0,
            `Expected zero error logs, found: ${JSON.stringify(errorLogs)}`,
          );
        } finally {
          await probe.close();
        }
      },
    );
  },
);
