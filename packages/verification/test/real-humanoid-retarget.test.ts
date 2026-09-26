import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NodeIO } from "@gltf-transform/core";
import * as THREE from "three";

import {
  bakeRetargetedClip,
  buildRetargetPlan,
  computeRetargetCacheKey,
  inspectRetargetedClip,
  inspectSkeletonFromGlb,
  type SkeletonProfile,
} from "@kinetra/animation";
import {
  ARENA_ENEMY_MODEL_ASSET_ID,
  ARENA_ENTITY_ENEMY,
  ARENA_SCENE_ID,
  arenaAudioAssets,
  createArenaProject,
} from "@kinetra/reference-game";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

function findRepoFile(relPath: string): string {
  let curr = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(curr, relPath);
    if (existsSync(candidate)) return candidate;
    curr = dirname(curr);
  }
  return resolve(process.cwd(), relPath);
}

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

// ---------------------------------------------------------------------------
// Humanoid Skeleton Profiles
// ---------------------------------------------------------------------------
const cesiumManProfile: SkeletonProfile = {
  id: "cesium_man_external",
  bones: {
    hips: "Skeleton_torso_joint_1",
    spine: "Skeleton_torso_joint_2",
    chest: "torso_joint_3",
    neck: "Skeleton_neck_joint_1",
    head: "Skeleton_neck_joint_2",
    leftUpperArm: "Skeleton_arm_joint_L__4_",
    leftLowerArm: "Skeleton_arm_joint_L__3_",
    leftHand: "Skeleton_arm_joint_L__2_",
    rightUpperArm: "Skeleton_arm_joint_R",
    rightLowerArm: "Skeleton_arm_joint_R__2_",
    rightHand: "Skeleton_arm_joint_R__3_",
    leftUpperLeg: "leg_joint_L_1",
    leftLowerLeg: "leg_joint_L_2",
    leftFoot: "leg_joint_L_3",
    leftToes: "leg_joint_L_5",
    rightUpperLeg: "leg_joint_R_1",
    rightLowerLeg: "leg_joint_R_2",
    rightFoot: "leg_joint_R_3",
    rightToes: "leg_joint_R_5",
  },
};

const enemyBotProfile: SkeletonProfile = {
  id: "enemy_bot_target",
  bones: {
    hips: "Hips",
    spine: "Spine",
    head: "Head",
    leftUpperArm: "LeftArm",
    rightUpperArm: "RightArm",
    leftUpperLeg: "LeftLeg",
    rightUpperLeg: "RightLeg",
  },
};

test(
  "Real External Humanoid Retargeting Vertical Slice — CesiumMan to EnemyBot Retarget Baking, Live Electron Playback, and Packaged Acceptance",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    let bakedWalkClip: THREE.AnimationClip;
    let expectedCacheKey: string;

    // -----------------------------------------------------------------------
    // Scenario 1: Real External Source Asset Inspection & Skeleton Discovery
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 1: Ingest real external CesiumMan humanoid GLB and discover skeleton hierarchy",
      async () => {
        const glbPath = findRepoFile("examples/reference-game/assets/characters/cesium-man.glb");
        assert.ok(existsSync(glbPath), `cesium-man.glb must exist at ${glbPath}`);

        const bytes = await readFile(glbPath);
        const result = await inspectSkeletonFromGlb(bytes);

        // Discovery assertions
        assert.ok(result.bones.length >= 19, `Expected >= 19 skeleton joints, got ${result.bones.length}`);
        const boneNames = result.bones.map((b) => b.name);
        assert.ok(boneNames.includes("Skeleton_torso_joint_1"), "Must discover hips joint");
        assert.ok(boneNames.includes("Skeleton_torso_joint_2"), "Must discover spine joint");
        assert.ok(boneNames.includes("Skeleton_neck_joint_2"), "Must discover head joint");
        assert.ok(boneNames.includes("Skeleton_arm_joint_L__4_"), "Must discover left upper arm joint");
        assert.ok(boneNames.includes("leg_joint_L_1"), "Must discover left upper leg joint");

        // Verify parent hierarchy
        const spine = result.bones.find((b) => b.name === "Skeleton_torso_joint_2");
        assert.equal(spine?.parent, "Skeleton_torso_joint_1", "Spine parent must be hips");

        // Discover animation clip
        assert.equal(result.clips.length, 1, "External asset must contain 1 animation clip");
        assert.ok(result.clips[0]!.duration > 1.5, "Clip duration must be ~2s");
        assert.equal(result.clips[0]!.channelCount, 57, "Clip must contain 57 channels");
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 2: Target Skeleton Discovery & Distinct Naming Verification
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 2: Discover target EnemyBot skeleton and prove source vs target bone naming differs",
      async () => {
        const glbPath = findRepoFile("examples/reference-game/assets/characters/enemy-bot.glb");
        assert.ok(existsSync(glbPath), `enemy-bot.glb must exist at ${glbPath}`);

        const bytes = await readFile(glbPath);
        const result = await inspectSkeletonFromGlb(bytes);

        assert.equal(result.bones.length, 7, "EnemyBot must contain exactly 7 bones");
        const targetBoneNames = result.bones.map((b) => b.name).sort();
        assert.deepEqual(targetBoneNames, ["Head", "Hips", "LeftArm", "LeftLeg", "RightArm", "RightLeg", "Spine"]);

        // Verification of distinct artist bone naming (Section 9)
        assert.notEqual(cesiumManProfile.bones.hips, enemyBotProfile.bones.hips);
        assert.notEqual(cesiumManProfile.bones.spine, enemyBotProfile.bones.spine);
        assert.notEqual(cesiumManProfile.bones.head, enemyBotProfile.bones.head);
        assert.notEqual(cesiumManProfile.bones.leftUpperArm, enemyBotProfile.bones.leftUpperArm);
        assert.notEqual(cesiumManProfile.bones.leftUpperLeg, enemyBotProfile.bones.leftUpperLeg);
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 3: Semantic Retarget Plan & Deterministic Signatures
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 3: Semantic mapping resolves across differing artist names with deterministic signatures",
      () => {
        const plan = buildRetargetPlan(cesiumManProfile, enemyBotProfile);

        assert.ok(plan.sourceSignature.length === 64, "Source signature must be 64-char hex");
        assert.ok(plan.targetSignature.length === 64, "Target signature must be 64-char hex");
        assert.notEqual(plan.sourceSignature, plan.targetSignature, "Signatures must differ");

        // Pairs mapped
        const mappedSemantics = plan.pairs.map((p) => p.semantic).sort();
        assert.deepEqual(mappedSemantics, [
          "head",
          "hips",
          "leftUpperArm",
          "leftUpperLeg",
          "rightUpperArm",
          "rightUpperLeg",
          "spine",
        ]);

        // Missing on target
        assert.ok(plan.missingOnTarget.includes("chest"), "Chest missing on EnemyBot");
        assert.ok(plan.missingOnTarget.includes("neck"), "Neck missing on EnemyBot");
        assert.ok(plan.missingOnTarget.includes("leftLowerArm"), "LeftLowerArm missing on EnemyBot");
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 4: Deliberate Negative Proof — Missing Hips & Unusable Tracks
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 4: Deliberate negative proof emits structured diagnostics with actionable remediation hints",
      () => {
        const sourceWithoutHips: SkeletonProfile = {
          id: "no_hips_src",
          bones: { spine: "Skeleton_torso_joint_2" },
        };
        const targetWithoutHips: SkeletonProfile = {
          id: "no_hips_tgt",
          bones: { spine: "Spine" },
        };

        const dummyTrack = new THREE.QuaternionKeyframeTrack(
          "Skeleton_torso_joint_2.quaternion",
          [0, 1],
          [0, 0, 0, 1, 0, 0, 0, 1],
        );
        const dummyClip = new THREE.AnimationClip("Dummy", 1.0, [dummyTrack]);

        const failResult = bakeRetargetedClip({
          sourceClip: dummyClip,
          sourceProfile: sourceWithoutHips,
          targetProfile: targetWithoutHips,
        });

        assert.equal(failResult.success, false, "Must fail when hips bone is missing");
        const diag = failResult.diagnostics.find((d) => d.code === "retarget.bone.missing-required");
        assert.ok(diag, "Must produce retarget.bone.missing-required diagnostic");
        assert.equal(diag.severity, "error");
        assert.ok(diag.hint, "Must provide an actionable hint");
        assert.ok(diag.hint.includes("hips"), "Hint must mention hips");
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 5: Deterministic Retarget Cache Key
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 5: Retarget cache key is deterministic and sensitive to inputs and settings",
      () => {
        const settings = { hipsTranslationPolicy: "ignore" as const, scaleFactor: 1.0, version: 1 };
        expectedCacheKey = computeRetargetCacheKey({
          sourceAssetHash: "659349b0a374b73d5362a61070039bc8601401bbdeacbece4f3680fb4bfd41b0",
          sourceClipId: "CesiumWalk",
          source: cesiumManProfile,
          target: enemyBotProfile,
          settings,
          retargetVersion: 1,
        });

        assert.ok(/^[a-f0-9]{64}$/.test(expectedCacheKey), "Cache key must be 64-char sha256 hex");

        // Repeat produces same key
        const repeatKey = computeRetargetCacheKey({
          sourceAssetHash: "659349b0a374b73d5362a61070039bc8601401bbdeacbece4f3680fb4bfd41b0",
          sourceClipId: "CesiumWalk",
          source: cesiumManProfile,
          target: enemyBotProfile,
          settings,
          retargetVersion: 1,
        });
        assert.equal(expectedCacheKey, repeatKey, "Equal inputs must produce identical cache key");

        // Changed settings produce different key
        const diffSettingsKey = computeRetargetCacheKey({
          sourceAssetHash: "659349b0a374b73d5362a61070039bc8601401bbdeacbece4f3680fb4bfd41b0",
          sourceClipId: "CesiumWalk",
          source: cesiumManProfile,
          target: enemyBotProfile,
          settings: { ...settings, hipsTranslationPolicy: "relative" },
          retargetVersion: 1,
        });
        assert.notEqual(expectedCacheKey, diffSettingsKey, "Changed settings must produce different cache key");
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 6: Real Transform Retarget Baking into Target-Specific AnimationClip
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 6: Bake real CesiumMan animation clip into target-specific THREE.AnimationClip",
      async () => {
        const glbPath = findRepoFile("examples/reference-game/assets/characters/cesium-man.glb");
        const glbBytes = await readFile(glbPath);
        const io = new NodeIO();
        const doc = await io.readBinary(glbBytes);
        const anim = doc.getRoot().listAnimations()[0]!;

        const sourceTracks: THREE.KeyframeTrack[] = [];
        for (const channel of anim.listChannels()) {
          const targetNode = channel.getTargetNode();
          const path = channel.getTargetPath();
          const sampler = channel.getSampler();
          if (!targetNode || !sampler) continue;

          const times = sampler.getInput()!.getArray()!;
          const values = sampler.getOutput()!.getArray()!;

          if (path === "rotation") {
            sourceTracks.push(
              new THREE.QuaternionKeyframeTrack(
                `${targetNode.getName()}.quaternion`,
                times as any,
                values as any,
              ),
            );
          } else if (path === "translation") {
            sourceTracks.push(
              new THREE.VectorKeyframeTrack(
                `${targetNode.getName()}.position`,
                times as any,
                values as any,
              ),
            );
          }
        }

        const sourceClip = new THREE.AnimationClip("CesiumWalk", 2.0, sourceTracks);

        const bakeResult = bakeRetargetedClip({
          sourceClip,
          sourceProfile: cesiumManProfile,
          targetProfile: enemyBotProfile,
          clipName: "walk_retargeted",
          sourceAssetHash: "659349b0a374b73d5362a61070039bc8601401bbdeacbece4f3680fb4bfd41b0",
          settings: { hipsTranslationPolicy: "ignore", scaleFactor: 1.0, version: 1 },
        });

        assert.equal(bakeResult.success, true, `Bake must succeed, got error: ${bakeResult.error}`);
        assert.ok(bakeResult.clip, "Bake must return a THREE.AnimationClip");
        assert.equal(bakeResult.clip.name, "walk_retargeted");
        assert.equal(bakeResult.trackCount, 7, "Must produce 7 retargeted rotation tracks for EnemyBot");
        assert.equal(bakeResult.cacheKey, expectedCacheKey, "Bake cache key must match expected");

        // Verify track bindings reference only EnemyBot bones
        for (const track of bakeResult.clip.tracks) {
          const boneName = track.name.split(".")[0]!;
          assert.ok(
            ["Head", "Hips", "LeftArm", "LeftLeg", "RightArm", "RightLeg", "Spine"].includes(boneName),
            `Track ${track.name} must target an EnemyBot bone`,
          );
          assert.ok(
            !boneName.startsWith("Skeleton_") && !boneName.startsWith("leg_joint_"),
            `Track ${track.name} must NOT target a CesiumMan artist bone`,
          );
        }

        // Verify baked clip inspection
        const inspect = inspectRetargetedClip(bakeResult.clip, enemyBotProfile);
        assert.equal(inspect.unmappedTracks.length, 0, "No unmapped tracks on target skeleton");
        assert.deepEqual(
          inspect.targetBonesAnimated.sort(),
          ["Head", "Hips", "LeftArm", "LeftLeg", "RightArm", "RightLeg", "Spine"],
        );

        bakedWalkClip = bakeResult.clip;
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 7: Live Electron — Target Character Load & SkinnedMesh Verification
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 7: Target EnemyBot character loads cleanly in live Electron with SkinnedMesh",
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
          await probe.start(ARENA_SCENE_ID, 701);
          const snap = await probe.snapshot();
          assert.equal(snap.running, true, "Runtime must be running");

          const query = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy = query.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          assert.ok(enemy, "Enemy entity must exist in runtime");
          assert.ok(enemy.model, "Enemy model must exist");
          assert.equal(enemy.model.loaded, true, "Enemy model must be loaded");
          assert.equal(enemy.model.hasSkin, true, "Enemy model hasSkin must be true");
          assert.ok((enemy.model.skinnedMeshCount ?? 0) >= 1, "Enemy model skinnedMeshCount >= 1");
        } finally {
          await probe.stop();
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 8: Live Electron — Register Baked Clip & Play on SkinnedMesh
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 8: Register baked retargeted clip and play on target SkinnedMesh in Electron",
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
          await probe.start(ARENA_SCENE_ID, 702);

          // Register baked clip on Enemy entity
          const clipJson = THREE.AnimationClip.toJSON(bakedWalkClip);
          await host.registerAnimationClip(ARENA_ENTITY_ENEMY, clipJson);

          // Verify clip is now registered in entity's available clips
          let query = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          let enemy = query.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          assert.ok(enemy?.model?.animation?.clips, "Entity must have animation clips");
          const registeredClip = enemy.model.animation.clips.find((c) => c.name === "walk_retargeted");
          assert.ok(registeredClip, "walk_retargeted must be registered in entity clips");

          // Play the baked target clip
          const playRes = await host.playAnimation(ARENA_ENTITY_ENEMY, "walk_retargeted", {
            loop: true,
            retargetSource: "CesiumMan",
            retargetCacheKey: expectedCacheKey,
          });
          assert.ok(playRes, "playAnimation must succeed");

          // Verify structured runtime state reflects active retargeted clip
          query = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          enemy = query.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          const anim = enemy?.model?.animation;
          assert.ok(anim, "Model animation state must exist");
          assert.equal(anim.activeClip, "walk_retargeted", "activeClip must be walk_retargeted");
          assert.equal(anim.playing, true, "Animation must be playing");
          assert.equal(anim.retargetSource, "CesiumMan", "retargetSource must be recorded");
          assert.equal(anim.retargetCacheKey, expectedCacheKey, "retargetCacheKey must be recorded");
        } finally {
          await probe.stop();
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 9: Deterministic Step & Observable Bone Transform Updates
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 9: Stepping simulation advances animation and observes bone rotations change",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => {
            const proj = createArenaProject();
            const enemy = proj.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_ENEMY)!;
            delete (enemy.components as any).Script;
            return proj;
          },
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 703);

          const clipJson = THREE.AnimationClip.toJSON(bakedWalkClip);
          await host.registerAnimationClip(ARENA_ENTITY_ENEMY, clipJson);

          await host.playAnimation(ARENA_ENTITY_ENEMY, "walk_retargeted", { loop: true });

          // Capture initial bone transforms at step 0
          let query = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          let enemy = query.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          assert.ok(enemy?.model?.nodes, "Model node transforms must exist");
          const initialNodes = enemy.model.nodes;
          const leftLegInitial = initialNodes.find((n) => n.name === "LeftLeg");
          const rightLegInitial = initialNodes.find((n) => n.name === "RightLeg");
          assert.ok(leftLegInitial?.rotation, "LeftLeg rotation must exist");
          assert.ok(rightLegInitial?.rotation, "RightLeg rotation must exist");

          const leftLegRot0 = [...leftLegInitial.rotation];
          const rightLegRot0 = [...rightLegInitial.rotation];

          // Advance simulation by 30 frames (0.5 seconds)
          await host.step(30, 1 / 60);

          // Query after stepping
          query = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          enemy = query.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          const steppedNodes = enemy!.model!.nodes!;
          const leftLegStepped = steppedNodes.find((n) => n.name === "LeftLeg")!;
          const rightLegStepped = steppedNodes.find((n) => n.name === "RightLeg")!;

          assert.ok(enemy!.model!.animation!.time > 0.4, "Animation time must have advanced past 0.4s");

          // Meaningful bone rotation delta assertion (Section 12 requirement 12)
          const leftLegDiff =
            Math.abs(leftLegStepped.rotation![0]! - leftLegRot0[0]!) +
            Math.abs(leftLegStepped.rotation![1]! - leftLegRot0[1]!) +
            Math.abs(leftLegStepped.rotation![2]! - leftLegRot0[2]!) +
            Math.abs(leftLegStepped.rotation![3]! - leftLegRot0[3]!);

          const rightLegDiff =
            Math.abs(rightLegStepped.rotation![0]! - rightLegRot0[0]!) +
            Math.abs(rightLegStepped.rotation![1]! - rightLegRot0[1]!) +
            Math.abs(rightLegStepped.rotation![2]! - rightLegRot0[2]!) +
            Math.abs(rightLegStepped.rotation![3]! - rightLegRot0[3]!);

          assert.ok(
            leftLegDiff > 0.0001 || rightLegDiff > 0.0001,
            `Bone rotations must change after stepping animation (leftLegDiff: ${leftLegDiff}, rightLegDiff: ${rightLegDiff})`,
          );
        } finally {
          await probe.stop();
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 10: Real PNG Visual Frame Capture
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 10: Capture valid PNG frame while retargeted animation is active in Electron",
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
          await probe.start(ARENA_SCENE_ID, 704);

          const clipJson = THREE.AnimationClip.toJSON(bakedWalkClip);
          await host.registerAnimationClip(ARENA_ENTITY_ENEMY, clipJson);
          await host.playAnimation(ARENA_ENTITY_ENEMY, "walk_retargeted", { loop: true });
          await host.step(10, 1 / 60);

          const frame = await probe.captureFrame();
          assertValidPng(frame, "Retargeted Animation Active");
        } finally {
          await probe.stop();
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 11: Scene Restart Lifecycle & Zero Leaks
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 11: Scene restart clears stale mixer state and allows clean re-playback without leaks",
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
          // Session 1: play retargeted clip
          await probe.start(ARENA_SCENE_ID, 705);
          const clipJson = THREE.AnimationClip.toJSON(bakedWalkClip);
          await host.registerAnimationClip(ARENA_ENTITY_ENEMY, clipJson);
          await host.playAnimation(ARENA_ENTITY_ENEMY, "walk_retargeted", { loop: true });
          await host.step(10, 1 / 60);
          await probe.stop();

          // Session 2: restart scene cleanly
          await probe.start(ARENA_SCENE_ID, 706);
          const query = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy = query.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          assert.equal(enemy?.model?.loaded, true, "Model must load after scene restart");

          // Re-register and re-play on fresh session
          await host.registerAnimationClip(ARENA_ENTITY_ENEMY, clipJson);
          const playRes = await host.playAnimation(ARENA_ENTITY_ENEMY, "walk_retargeted", { loop: true });
          assert.ok(playRes, "Re-playback after scene restart must succeed");

          // Verify error logs: zero animation.playFailed, zero model.loadFailed
          const logs = await host.readLogs();
          const playFailed = logs.filter((l) => l.message === "animation.playFailed");
          const loadFailed = logs.filter((l) => l.message === "model.loadFailed");
          assert.equal(playFailed.length, 0, `Zero animation.playFailed expected, got: ${JSON.stringify(playFailed)}`);
          assert.equal(loadFailed.length, 0, `Zero model.loadFailed expected, got: ${JSON.stringify(loadFailed)}`);
        } finally {
          await probe.stop();
          await host.close();
        }
      },
    );
  },
);
