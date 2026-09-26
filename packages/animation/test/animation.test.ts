import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NodeIO } from "@gltf-transform/core";
import * as THREE from "three";

import {
  AnimationGraphMachine,
  bakeRetargetedClip,
  buildRetargetPlan,
  computeRetargetCacheKey,
  extractRootMotion,
  inspectRetargetedClip,
  inspectSkeletonFromGlb,
  retargetCacheKey,
  skeletonSignature,
  validateAnimationGraph,
  validateSkeletonProfile,
  type AnimationGraphDefinition,
  type SkeletonProfile,
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

const source: SkeletonProfile = {
  id: "mixamo",
  bones: {
    hips: "mixamorigHips",
    spine: "mixamorigSpine",
    head: "mixamorigHead",
    leftUpperArm: "mixamorigLeftArm",
    leftLowerArm: "mixamorigLeftForeArm",
    leftHand: "mixamorigLeftHand",
    rightUpperArm: "mixamorigRightArm",
    rightLowerArm: "mixamorigRightForeArm",
    rightHand: "mixamorigRightHand",
    leftUpperLeg: "mixamorigLeftUpLeg",
    leftLowerLeg: "mixamorigLeftLeg",
    leftFoot: "mixamorigLeftFoot",
    rightUpperLeg: "mixamorigRightUpLeg",
    rightLowerLeg: "mixamorigRightLeg",
    rightFoot: "mixamorigRightFoot",
  },
};

const target: SkeletonProfile = {
  id: "hero",
  bones: {
    hips: "Hips",
    spine: "Spine",
    head: "Head",
    leftUpperArm: "UpperArm.L",
    leftLowerArm: "LowerArm.L",
    leftHand: "Hand.L",
    rightUpperArm: "UpperArm.R",
    rightLowerArm: "LowerArm.R",
    rightHand: "Hand.R",
    leftUpperLeg: "Thigh.L",
    leftLowerLeg: "Shin.L",
    leftFoot: "Foot.L",
    rightUpperLeg: "Thigh.R",
    rightLowerLeg: "Shin.R",
    rightFoot: "Foot.R",
  },
};

test("skeleton profiles produce deterministic signatures and retarget pairs", () => {
  assert.equal(validateSkeletonProfile(source).filter((d) => d.severity === "error").length, 0);
  assert.equal(skeletonSignature(source), skeletonSignature(structuredClone(source)));
  const plan = buildRetargetPlan(source, target);
  assert.ok(plan.pairs.some((pair) => pair.semantic === "hips" && pair.targetBone === "Hips"));
  assert.equal(plan.missingOnTarget.length, 0);
});

test("retarget cache key changes when settings change", () => {
  const a = retargetCacheKey({ sourceClipId: "walk", source, target, settings: { scale: 1 } });
  const b = retargetCacheKey({ sourceClipId: "walk", source, target, settings: { scale: 2 } });
  assert.notEqual(a, b);
});

test("root motion extracts XZ and yaw while making clip in-place", () => {
  const result = extractRootMotion(
    [
      { time: 0, position: [0, 1, 0], yaw: 0 },
      { time: 0.5, position: [1, 1, 2], yaw: 0.2 },
      { time: 1, position: [2, 1, 4], yaw: 0.5 },
    ],
    "extract-xz-yaw",
  );
  assert.deepEqual(result.deltas[0]?.translation, [1, 0, 2]);
  assert.equal(result.deltas[1]?.yaw, 0.3);
  assert.deepEqual(result.inPlace[2]?.position, [0, 1, 0]);
  assert.equal(result.inPlace[2]?.yaw, 0);
});

function graph(): AnimationGraphDefinition {
  return {
    schemaVersion: 1,
    entryState: "idle",
    parameters: {
      speed: { type: "number", default: 0 },
      grounded: { type: "bool", default: true },
      jump: { type: "trigger" },
    },
    states: [
      { id: "idle", clipId: "idle" },
      { id: "run", clipId: "run" },
      { id: "jump", clipId: "jump", loop: false },
    ],
    transitions: [
      { id: "jump", from: "idle", to: "jump", priority: 10, conditions: [{ parameter: "jump", op: "triggered" }] },
      { id: "run", from: "idle", to: "run", conditions: [{ parameter: "speed", op: ">", value: 0.1 }] },
    ],
  };
}

test("animation graph uses priorities and consumes triggers", () => {
  const machine = new AnimationGraphMachine(graph());
  machine.set("speed", 1);
  machine.trigger("jump");
  const transition = machine.evaluate();
  assert.equal(transition?.transitionId, "jump");
  assert.equal(machine.state, "jump");
});

test("invalid animation graph reports missing state and parameter", () => {
  const bad = graph();
  bad.entryState = "missing";
  bad.transitions.push({
    id: "bad",
    from: "idle",
    to: "missing",
    conditions: [{ parameter: "wat", op: "==", value: true }],
  });
  const codes = validateAnimationGraph(bad).map((d) => d.code);
  assert.ok(codes.includes("anim.entry.missing"));
  assert.ok(codes.includes("anim.transition.to.missing"));
  assert.ok(codes.includes("anim.condition.parameter.missing"));
});

test("inspectSkeletonFromGlb discovers external CesiumMan skeleton joints and clips", async () => {
  const glbPath = findRepoFile("examples/reference-game/assets/characters/cesium-man.glb");
  const bytes = await readFile(glbPath);
  const result = await inspectSkeletonFromGlb(bytes);

  assert.ok(result.bones.length >= 19, `Expected >= 19 bones, got ${result.bones.length}`);
  const boneNames = result.bones.map((b) => b.name);
  assert.ok(boneNames.includes("Skeleton_torso_joint_1"), "Must discover Skeleton_torso_joint_1 (hips)");
  assert.ok(boneNames.includes("Skeleton_torso_joint_2"), "Must discover Skeleton_torso_joint_2 (spine)");
  assert.ok(boneNames.includes("Skeleton_arm_joint_L__4_"), "Must discover Skeleton_arm_joint_L__4_ (leftUpperArm)");
  assert.ok(boneNames.includes("leg_joint_L_1"), "Must discover leg_joint_L_1 (leftUpperLeg)");

  // Parent hierarchy
  const spine = result.bones.find((b) => b.name === "Skeleton_torso_joint_2");
  assert.equal(spine?.parent, "Skeleton_torso_joint_1", "Spine parent must be hips");

  // Animation clips
  assert.equal(result.clips.length, 1, "CesiumMan must contain 1 animation clip");
  assert.ok(result.clips[0]!.duration > 1.5, `Clip duration must be ~2s, got ${result.clips[0]!.duration}`);
  assert.equal(result.clips[0]!.channelCount, 57, "Clip must contain 57 channels");
});

test("inspectSkeletonFromGlb discovers EnemyBot synthetic character skeleton joints and combat clips", async () => {
  const glbPath = findRepoFile("examples/reference-game/assets/characters/enemy-bot.glb");
  const bytes = await readFile(glbPath);
  const result = await inspectSkeletonFromGlb(bytes);

  assert.equal(result.bones.length, 7, "EnemyBot must contain exactly 7 bones");
  const boneNames = result.bones.map((b) => b.name);
  assert.deepEqual(boneNames.sort(), ["Head", "Hips", "LeftArm", "LeftLeg", "RightArm", "RightLeg", "Spine"]);

  // 6 combat clips
  assert.equal(result.clips.length, 6, "EnemyBot must contain 6 combat animation clips");
  const clipNames = result.clips.map((c) => c.name).sort();
  assert.deepEqual(clipNames, ["attack", "defeat", "hurt", "idle", "telegraph", "walk"]);
});

test("bakeRetargetedClip generates target-specific THREE.AnimationClip across differing skeleton names", async () => {
  const cesiumProfile: SkeletonProfile = {
    id: "cesium_man",
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

  const enemyProfile: SkeletonProfile = {
    id: "enemy_bot",
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

  // Read glTF and extract THREE.KeyframeTracks for the source clip
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
        new THREE.QuaternionKeyframeTrack(`${targetNode.getName()}.quaternion`, times as any, values as any),
      );
    } else if (path === "translation") {
      sourceTracks.push(
        new THREE.VectorKeyframeTrack(`${targetNode.getName()}.position`, times as any, values as any),
      );
    }
  }

  const sourceClip = new THREE.AnimationClip("CesiumWalk", 2.0, sourceTracks);

  // Bake clip onto EnemyBot skeleton
  const result = bakeRetargetedClip({
    sourceClip,
    sourceProfile: cesiumProfile,
    targetProfile: enemyProfile,
    clipName: "walk_retargeted",
    sourceAssetHash: "659349b0a374b73d5362a61070039bc8601401bbdeacbece4f3680fb4bfd41b0",
    settings: { hipsTranslationPolicy: "ignore", scaleFactor: 1.0, version: 1 },
  });

  assert.equal(result.success, true, `Bake must succeed, error: ${result.error}`);
  assert.ok(result.clip, "Must return a baked THREE.AnimationClip");
  assert.equal(result.clip.name, "walk_retargeted");
  assert.equal(result.clip.duration, sourceClip.duration);

  // Verify all track bindings target EnemyBot bones, not CesiumMan bones
  for (const track of result.clip.tracks) {
    const nodeName = track.name.split(".")[0]!;
    assert.ok(
      ["Hips", "Spine", "Head", "LeftArm", "RightArm", "LeftLeg", "RightLeg"].includes(nodeName),
      `Track ${track.name} must target an EnemyBot bone`,
    );
    assert.ok(
      !nodeName.startsWith("Skeleton_") && !nodeName.startsWith("leg_joint_"),
      `Track ${track.name} must not contain source artist bone name`,
    );
  }

  // Inspect retargeted clip
  const inspection = inspectRetargetedClip(result.clip, enemyProfile);
  assert.equal(inspection.unmappedTracks.length, 0, "No unmapped tracks on target skeleton");
  assert.deepEqual(
    inspection.targetBonesAnimated.sort(),
    ["Head", "Hips", "LeftArm", "LeftLeg", "RightArm", "RightLeg", "Spine"],
    "All 7 EnemyBot bones must be animated",
  );

  // Deterministic cache key
  const expectedKey = computeRetargetCacheKey({
    sourceAssetHash: "659349b0a374b73d5362a61070039bc8601401bbdeacbece4f3680fb4bfd41b0",
    sourceClipId: "CesiumWalk",
    source: cesiumProfile,
    target: enemyProfile,
    settings: { hipsTranslationPolicy: "ignore", scaleFactor: 1.0, version: 1 },
    retargetVersion: 1,
  });
  assert.equal(result.cacheKey, expectedKey, "Cache key must match computeRetargetCacheKey output");

  // Three.js JSON serialization roundtrip
  const json = THREE.AnimationClip.toJSON(result.clip);
  const parsed = THREE.AnimationClip.parse(json);
  assert.equal(parsed.name, result.clip.name);
  assert.equal(parsed.duration, result.clip.duration);
  assert.equal(parsed.tracks.length, result.clip.tracks.length);
});

test("bakeRetargetedClip deliberate negative proof: missing hips produces structured failure with hint", () => {
  const sourceProfile: SkeletonProfile = {
    id: "src_no_hips",
    bones: { spine: "SpineBone", leftUpperArm: "ArmL" },
  };

  const targetProfile: SkeletonProfile = {
    id: "tgt_no_hips",
    bones: { spine: "Spine", leftUpperArm: "LeftArm" },
  };

  const track = new THREE.QuaternionKeyframeTrack("SpineBone.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
  const sourceClip = new THREE.AnimationClip("TestClip", 1.0, [track]);

  const result = bakeRetargetedClip({
    sourceClip,
    sourceProfile,
    targetProfile,
  });

  assert.equal(result.success, false, "Must fail when hips bone is missing");
  assert.ok(result.error?.includes("hips"), "Error must mention missing hips");
  const hipDiag = result.diagnostics.find((d) => d.code === "retarget.bone.missing-required");
  assert.ok(hipDiag, "Must emit retarget.bone.missing-required diagnostic");
  assert.ok(hipDiag?.hint, "Diagnostic must include an actionable remediation hint");
});

test("bakeRetargetedClip deliberate negative proof: clip with no usable tracks produces structured failure", () => {
  const sourceProfile: SkeletonProfile = {
    id: "src",
    bones: { hips: "HipsSource", spine: "SpineSource" },
  };

  const targetProfile: SkeletonProfile = {
    id: "tgt",
    bones: { hips: "HipsTarget", spine: "SpineTarget" },
  };

  // Track targets an unmapped bone "UnknownNode"
  const track = new THREE.QuaternionKeyframeTrack("UnknownNode.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
  const sourceClip = new THREE.AnimationClip("TestClip", 1.0, [track]);

  const result = bakeRetargetedClip({
    sourceClip,
    sourceProfile,
    targetProfile,
  });

  assert.equal(result.success, false, "Must fail when no tracks can be retargeted");
  const trackDiag = result.diagnostics.find((d) => d.code === "retarget.clip.no-usable-tracks");
  assert.ok(trackDiag, "Must emit retarget.clip.no-usable-tracks diagnostic");
  assert.ok(trackDiag?.hint, "Must include remediation hint");
});

test("computeRetargetCacheKey is deterministic and sensitive to all parameters", () => {
  const baseInput = {
    sourceAssetHash: "hash_a",
    sourceClipId: "walk",
    source,
    target,
    settings: { hipsTranslationPolicy: "ignore" as const, version: 1 },
    retargetVersion: 1,
  };

  const key1 = computeRetargetCacheKey(baseInput);
  const key2 = computeRetargetCacheKey({ ...baseInput });
  assert.equal(key1, key2, "Equivalent inputs must yield identical cache keys");

  // Changed asset hash
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, sourceAssetHash: "hash_b" }));
  // Changed clip id
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, sourceClipId: "run" }));
  // Changed retarget version
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, retargetVersion: 2 }));
  // Changed settings
  assert.notEqual(
    key1,
    computeRetargetCacheKey({
      ...baseInput,
      settings: { hipsTranslationPolicy: "relative", version: 1 },
    }),
  );
  // Changed skeleton profile
  const modifiedTarget: SkeletonProfile = {
    id: "hero_mod",
    bones: { ...target.bones, head: "NewHead" },
  };
  assert.notEqual(key1, computeRetargetCacheKey({ ...baseInput, target: modifiedTarget }));
});

