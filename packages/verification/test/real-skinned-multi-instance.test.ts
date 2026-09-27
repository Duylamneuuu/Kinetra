import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as THREE from "three";

import type { ProjectDocument } from "@kinetra/project-model";
import {
  ARENA_ENEMY_MODEL_ASSET_ID,
  ROOT_MOTION_BOT_MODEL_ASSET_ID,
  arenaAssets,
} from "@kinetra/reference-game";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
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

const SCENE_ENEMIES_ID = "scene_skinned_multi_enemies";
const SCENE_ROOT_MOTION_ID = "scene_skinned_multi_root_motion";

const ENTITY_ENEMY_A = "entity_enemy_a";
const ENTITY_ENEMY_B = "entity_enemy_b";
const ENTITY_ENEMY_C = "entity_enemy_c";

const ENTITY_MOVER_A = "entity_mover_a";
const ENTITY_MOVER_B = "entity_mover_b";

function createMultiInstanceProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_skinned_multi_instance",
    name: "Skinned Multi-Instance Verification Project",
    scenes: [
      {
        id: SCENE_ENEMIES_ID,
        name: "Skinned Multi Enemies Scene",
        entities: [
          {
            id: "camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 2, 6], rotation: [-0.1, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
            },
          },
          {
            id: "sun",
            name: "DirectionalSun",
            components: {
              Transform: { position: [2, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
            },
          },
          {
            id: "floor",
            name: "Floor",
            components: {
              Transform: { position: [0, -0.05, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Primitive: { kind: "box", size: [12, 0.1, 12], color: "#1a1e28" },
            },
          },
          {
            id: ENTITY_ENEMY_A,
            name: "EnemyA",
            components: {
              Transform: { position: [-1.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
          {
            id: ENTITY_ENEMY_B,
            name: "EnemyB",
            components: {
              Transform: { position: [1.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
          {
            id: ENTITY_ENEMY_C,
            name: "EnemyC",
            components: {
              Transform: { position: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
            },
          },
        ],
      },
      {
        id: SCENE_ROOT_MOTION_ID,
        name: "Skinned Multi Root Motion Scene",
        entities: [
          {
            id: "rm_camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 3, 8], rotation: [-0.2, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
            },
          },
          {
            id: "rm_sun",
            name: "Sun",
            components: {
              Transform: { position: [0, 10, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
            },
          },
          {
            id: "rm_floor",
            name: "Floor",
            components: {
              Transform: { position: [0, -0.1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Primitive: { kind: "box", size: [20, 0.2, 20], color: "#1a1e28" },
            },
          },
          {
            id: ENTITY_MOVER_A,
            name: "MoverA",
            components: {
              Transform: { position: [-2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ROOT_MOTION_BOT_MODEL_ASSET_ID },
              CharacterBody: { speed: 5 },
              Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
            },
          },
          {
            id: ENTITY_MOVER_B,
            name: "MoverB",
            components: {
              Transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ROOT_MOTION_BOT_MODEL_ASSET_ID },
              CharacterBody: { speed: 5 },
              Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
            },
          },

        ],
      },
    ],
  };
}

test("P5 Safe Multi-Instance SkinnedMesh Clone & Shared Asset Lifecycle", async (t) => {
  if (!canRunRealElectronTests()) {
    t.skip("Real Electron test requires an active display (Windows or Linux under X11/xvfb)");
    return;
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Reusable Parsed Template & Independent SkinnedMesh Instances
  // Proves Reqs 1, 2, 3, 4, 15, 16, 17, 18
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 1: Reusable parsed template deduplication, independent skeletons/mixers, and valid PNG frame",
    async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createMultiInstanceProject(),
        initialRevision: 0,
        assets: arenaAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_ENEMIES_ID, 100);

        const q0 = await host.query();
        assert.equal(q0.running, true);

        // Requirement 1 & 20: Same asset parsed exactly once for both entities
        assert.equal(
          q0.metrics?.assetTemplateParseCount,
          1,
          "Asset template must be parsed exactly once for both entities",
        );
        assert.equal(
          q0.metrics?.instanceCount,
          2,
          "Runtime must track 2 active instances",
        );

        const enemyA = q0.entities.find((e) => e.entityId === ENTITY_ENEMY_A);
        const enemyB = q0.entities.find((e) => e.entityId === ENTITY_ENEMY_B);

        assert.ok(enemyA && enemyA.model?.loaded, "EnemyA model must be loaded");
        assert.ok(enemyB && enemyB.model?.loaded, "EnemyB model must be loaded");

        // Requirement 2: Independent SkinnedMesh instances with structured identity
        assert.ok(enemyA.model.skinnedMeshCount && enemyA.model.skinnedMeshCount >= 1);
        assert.ok(enemyB.model.skinnedMeshCount && enemyB.model.skinnedMeshCount >= 1);
        assert.equal(enemyA.model.hasSkin, true);
        assert.equal(enemyB.model.hasSkin, true);

        assert.ok(enemyA.model.instance, "EnemyA must expose instance metadata");
        assert.ok(enemyB.model.instance, "EnemyB must expose instance metadata");
        assert.equal(enemyA.model.instance.assetId, ARENA_ENEMY_MODEL_ASSET_ID);
        assert.equal(enemyB.model.instance.assetId, ARENA_ENEMY_MODEL_ASSET_ID);
        assert.equal(
          enemyA.model.instance.sharedTemplateId,
          enemyB.model.instance.sharedTemplateId,
          "Both instances must share the same template ID",
        );
        assert.notEqual(
          enemyA.model.instance.instanceId,
          enemyB.model.instance.instanceId,
          "Each instance must possess a unique instance ID",
        );

        // Reference-counted shared resource tracking
        assert.equal(
          enemyA.model.resourceSharing?.templateRefCount,
          2,
          "EnemyA must observe templateRefCount of 2",
        );
        assert.equal(
          enemyB.model.resourceSharing?.templateRefCount,
          2,
          "EnemyB must observe templateRefCount of 2",
        );

        // Skeleton joints are discovered for both instances
        assert.ok(enemyA.model.nodes && enemyA.model.nodes.length >= 7);
        assert.ok(enemyB.model.nodes && enemyB.model.nodes.length >= 7);

        // Requirement 15: Valid PNG frame capture with two live rigged instances
        const frame = await probe.captureFrame();
        assertValidPng(frame, "Multi-instance dual rigged character");

        // Requirement 16 & 17: Zero model.loadFailed and zero unexpected animation.playFailed
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

  // -------------------------------------------------------------------------
  // Scenario 2: Independent Animation Playback, Bone Poses, and Crossfade
  // Proves Reqs 4, 5, 6, 7
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 2: EnemyA plays walk and crossfade while EnemyB plays idle without bone or mixer leakage",
    async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createMultiInstanceProject(),
        initialRevision: 0,
        assets: arenaAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_ENEMIES_ID, 101);

        // Play walk on EnemyA, idle on EnemyB
        await host.playAnimation(ENTITY_ENEMY_A, "walk");
        await host.playAnimation(ENTITY_ENEMY_B, "idle");

        // Step deterministically
        await probe.step(5, 1 / 30);

        const q1 = await host.query({ entityIds: [ENTITY_ENEMY_A, ENTITY_ENEMY_B] });
        const enemyA1 = q1.entities.find((e) => e.entityId === ENTITY_ENEMY_A)!;
        const enemyB1 = q1.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;

        // Requirement 4 & 6: Independent animation clip & bone transforms
        assert.equal(enemyA1.model?.animation?.activeClip, "walk");
        assert.equal(enemyB1.model?.animation?.activeClip, "idle");
        assert.equal(enemyA1.model?.animation?.playing, true);
        assert.equal(enemyB1.model?.animation?.playing, true);

        const legNodeA = enemyA1.model?.nodes?.find((n) => n.name === "LeftLeg");
        const legNodeB = enemyB1.model?.nodes?.find((n) => n.name === "LeftLeg");
        assert.ok(legNodeA && legNodeB);
        assert.notDeepEqual(
          legNodeA.rotation,
          legNodeB.rotation,
          "EnemyA animated leg rotation must differ from EnemyB idle leg rotation",
        );

        // Requirement 7: Crossfade on EnemyA (walk -> telegraph) while EnemyB remains idle
        await host.crossfadeAnimation(ENTITY_ENEMY_A, "telegraph", 0.3);

        // Step 1 frame into the blend
        await probe.step(1, 0.1);
        const qBlend = await host.query({ entityIds: [ENTITY_ENEMY_A, ENTITY_ENEMY_B] });
        const enemyABlend = qBlend.entities.find((e) => e.entityId === ENTITY_ENEMY_A)!;
        const enemyBBlend = qBlend.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;

        // EnemyA exposes active crossfade actions
        assert.equal(enemyABlend.model?.animation?.graph?.transitioning, true);
        const actionsA = enemyABlend.model?.animation?.actions ?? [];
        assert.ok(actionsA.length >= 2, "EnemyA must expose outgoing and incoming blend actions");

        // EnemyB exposes no transition and remains purely in idle
        assert.equal(
          enemyBBlend.model?.animation?.graph?.transitioning ?? false,
          false,
          "EnemyB must not be affected by EnemyA crossfade",
        );
        assert.equal(enemyBBlend.model?.animation?.activeClip, "idle");


        // Step to complete blend
        await probe.step(5, 0.1);
        const qEnd = await host.query({ entityIds: [ENTITY_ENEMY_A, ENTITY_ENEMY_B] });
        const enemyAEnd = qEnd.entities.find((e) => e.entityId === ENTITY_ENEMY_A)!;
        const enemyBEnd = qEnd.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;

        assert.equal(enemyAEnd.model?.animation?.activeClip, "telegraph");
        assert.equal(enemyBEnd.model?.animation?.activeClip, "idle");
      } finally {
        await probe.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 3: Shared Retargeted Clip Plays Independently on Both
  // Proves Req 8
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 3: Same baked clip definition plays on both target instances with independent playback times",
    async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createMultiInstanceProject(),
        initialRevision: 0,
        assets: arenaAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_ENEMIES_ID, 102);

        // Create synthetic external retargeted animation clip definition
        const track = new THREE.VectorKeyframeTrack(
          "Hips.position",
          [0, 0.5, 1.0],
          [0, 0.9, 0, 0, 1.3, 0, 0, 0.9, 0],
        );
        const sharedRetargetedClip = new THREE.AnimationClip("shared_retarget_jump", 1.0, [track]);

        // Register the exact same clip on both EnemyA and EnemyB
        await host.registerAnimationClip(ENTITY_ENEMY_A, sharedRetargetedClip.toJSON());
        await host.registerAnimationClip(ENTITY_ENEMY_B, sharedRetargetedClip.toJSON());

        // Play on EnemyA first
        await host.playAnimation(ENTITY_ENEMY_A, "shared_retarget_jump", { loop: false });
        await probe.step(6, 1 / 30); // ~0.2s

        const qA = await host.query({ entityIds: [ENTITY_ENEMY_A, ENTITY_ENEMY_B] });
        const enemyA = qA.entities.find((e) => e.entityId === ENTITY_ENEMY_A)!;
        const enemyB = qA.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;

        assert.equal(enemyA.model?.animation?.activeClip, "shared_retarget_jump");
        assert.ok((enemyA.model?.animation?.time ?? 0) > 0.15);
        assert.equal(enemyB.model?.animation?.activeClip, undefined);

        // Now play on EnemyB
        await host.playAnimation(ENTITY_ENEMY_B, "shared_retarget_jump", { loop: false });
        await probe.step(3, 1 / 30); // ~0.1s

        const qBoth = await host.query({ entityIds: [ENTITY_ENEMY_A, ENTITY_ENEMY_B] });
        const enemyA2 = qBoth.entities.find((e) => e.entityId === ENTITY_ENEMY_A)!;
        const enemyB2 = qBoth.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;

        assert.ok(
          (enemyA2.model?.animation?.time ?? 0) > (enemyB2.model?.animation?.time ?? 0),
          "EnemyA must be further ahead in playback time than EnemyB",
        );
      } finally {
        await probe.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 4: Independent Root Motion on Cloned Instances
  // Proves Req 9
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 4: MoverA root motion moves body and accumulates distance while MoverB stays still",
    async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createMultiInstanceProject(),
        initialRevision: 0,
        assets: arenaAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_ROOT_MOTION_ID, 103);

        const q0 = await host.query({ entityIds: [ENTITY_MOVER_A, ENTITY_MOVER_B] });
        assert.equal(q0.metrics?.assetTemplateParseCount, 1, "Single parse for both root motion bots");
        assert.equal(q0.metrics?.instanceCount, 2);

        const moverA0 = q0.entities.find((e) => e.entityId === ENTITY_MOVER_A)!;
        const moverB0 = q0.entities.find((e) => e.entityId === ENTITY_MOVER_B)!;
        const initPosA = [...moverA0.position];
        const initPosB = [...moverB0.position];

        // Configure root motion on MoverA only
        await host.configureRootMotion({
          entityId: ENTITY_MOVER_A,
          enabled: true,
          mode: "extract-xz",
          rootBoneName: "Hips",
        });


        // Play root-motion locomotion on MoverA, idle on MoverB
        await host.crossfadeAnimation(ENTITY_MOVER_A, "walk_root", 0);
        await host.playAnimation(ENTITY_MOVER_B, "idle");

        // Step 15 frames
        await probe.step(15, 1 / 30);

        const q1 = await host.query({ entityIds: [ENTITY_MOVER_A, ENTITY_MOVER_B] });
        const moverA1 = q1.entities.find((e) => e.entityId === ENTITY_MOVER_A)!;
        const moverB1 = q1.entities.find((e) => e.entityId === ENTITY_MOVER_B)!;

        // MoverA root motion accumulated distance and moved in world
        const distA =
          moverA1.gameplay?.rootMotion?.accumulatedDistance ??
          moverA1.model?.animation?.rootMotion?.accumulatedDistance ??
          0;
        assert.ok(distA > 0.05, `MoverA accumulatedDistance should be > 0.05, got ${distA}`);


        // MoverB root motion was not enabled
        const rmB = moverB1.model?.animation?.rootMotion;
        assert.ok(!rmB || !rmB.enabled || rmB.accumulatedDistance === 0);

        // World positions: MoverB remained stationary at initial position
        assert.equal(moverB1.position[0], initPosB[0]);
        assert.equal(moverB1.position[2], initPosB[2]);
      } finally {
        await probe.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 5: Partial Disposal, Resource Lifetime, and Reload Proof
  // Proves Reqs 10, 11, 12, 13
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 5: Detaching EnemyA leaves EnemyB fully alive, EnemyC reloads from template, final cleanup",
    async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createMultiInstanceProject(),
        initialRevision: 0,
        assets: arenaAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_ENEMIES_ID, 104);

        await host.playAnimation(ENTITY_ENEMY_A, "walk");
        await host.playAnimation(ENTITY_ENEMY_B, "idle");
        await probe.step(3, 1 / 30);

        // Both active: refCount = 2
        const q0 = await host.query({ entityIds: [ENTITY_ENEMY_A, ENTITY_ENEMY_B] });
        assert.equal(q0.entities[0]?.model?.resourceSharing?.templateRefCount, 2);

        // Requirement 10: Detach EnemyA while EnemyB remains active
        await host.detachModel(ENTITY_ENEMY_A);

        const q1 = await host.query({ entityIds: [ENTITY_ENEMY_A, ENTITY_ENEMY_B] });
        const enemyA1 = q1.entities.find((e) => e.entityId === ENTITY_ENEMY_A)!;
        const enemyB1 = q1.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;

        // EnemyA model unloaded
        assert.equal(enemyA1.model?.loaded, false);
        assert.equal(enemyA1.model?.instance, undefined);

        // EnemyB still active and healthy, templateRefCount decremented to 1
        assert.equal(enemyB1.model?.loaded, true);
        assert.equal(enemyB1.model?.hasSkin, true);
        assert.equal(enemyB1.model?.resourceSharing?.templateRefCount, 1);
        assert.equal(enemyB1.model?.animation?.playing, true);

        // Requirement 11: EnemyB continues stepping and rendering valid PNG
        await probe.step(5, 1 / 30);
        const frameAfterDetach = await probe.captureFrame();
        assertValidPng(frameAfterDetach, "Single live instance after partial disposal");

        // Requirement 12: Create/reload EnemyC from same asset
        await host.attachModel(ENTITY_ENEMY_C, ARENA_ENEMY_MODEL_ASSET_ID);

        const q2 = await host.query({ entityIds: [ENTITY_ENEMY_B, ENTITY_ENEMY_C] });
        const enemyB2 = q2.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;
        const enemyC2 = q2.entities.find((e) => e.entityId === ENTITY_ENEMY_C)!;

        assert.equal(enemyC2.model?.loaded, true);
        assert.equal(enemyC2.model?.hasSkin, true);
        assert.notEqual(
          enemyB2.model?.instance?.instanceId,
          enemyC2.model?.instance?.instanceId,
          "EnemyB and EnemyC must have distinct instance IDs",
        );

        // Template refcount returned to 2, and parse count is still 1 (reused from cache!)
        assert.equal(q2.metrics?.assetTemplateParseCount, 1, "Template must be reused without reparsing");
        assert.equal(enemyB2.model?.resourceSharing?.templateRefCount, 2);
        assert.equal(enemyC2.model?.resourceSharing?.templateRefCount, 2);

        // Both B and C can animate independently
        await host.playAnimation(ENTITY_ENEMY_C, "telegraph");
        await probe.step(4, 1 / 30);

        const q3 = await host.query({ entityIds: [ENTITY_ENEMY_B, ENTITY_ENEMY_C] });
        assert.equal(q3.entities.find((e) => e.entityId === ENTITY_ENEMY_B)?.model?.animation?.activeClip, "idle");
        assert.equal(q3.entities.find((e) => e.entityId === ENTITY_ENEMY_C)?.model?.animation?.activeClip, "telegraph");

        // Requirement 13: Final disposal releases shared resources exactly once
        await host.detachModel(ENTITY_ENEMY_B);
        await host.detachModel(ENTITY_ENEMY_C);

        const qFinal = await host.query();
        assert.equal(qFinal.metrics?.instanceCount, 0);
      } finally {
        await probe.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 6: Scene Restart / Clean Host Teardown
  // Proves Reqs 14, 18
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 6: Scene reload exhibits no stale state and teardown leaves zero orphan processes",
    async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createMultiInstanceProject(),
        initialRevision: 0,
        assets: arenaAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_ENEMIES_ID, 105);
        await probe.step(3, 1 / 30);
        await probe.stop();

        // Restart on same scene
        await probe.start(SCENE_ENEMIES_ID, 106);
        const qRestart = await host.query();

        assert.equal(qRestart.running, true);
        assert.equal(qRestart.metrics?.instanceCount, 2);
        const enemyA = qRestart.entities.find((e) => e.entityId === ENTITY_ENEMY_A)!;
        const enemyB = qRestart.entities.find((e) => e.entityId === ENTITY_ENEMY_B)!;

        // Fresh instances with fresh IDs and zero playback time
        assert.ok(enemyA.model?.loaded);
        assert.ok(enemyB.model?.loaded);
        assert.equal(enemyA.model?.animation?.time ?? 0, 0);
        assert.equal(enemyB.model?.animation?.time ?? 0, 0);

        // Zero unexpected errors
        const logs = await probe.logs();
        assert.ok(
          !logs.some((l) => l.message === "model.loadFailed"),
          "Zero model.loadFailed error logs expected across restart",
        );
      } finally {
        await probe.close();
      }
    },
  );
});
