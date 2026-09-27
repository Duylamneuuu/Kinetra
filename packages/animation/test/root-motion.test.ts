import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  computeRootMotionStepDelta,
  extractRootMotionFromClip,
  inspectClipRootMotion,
  stripVisualRootDisplacement,
  type RootMotionSample,
} from "../src/root-motion.js";

test("Root Motion: computeRootMotionStepDelta produces exact linear deltas and clean loop wrap without spike", () => {
  // 1.0s clip moving +Z by 1.6m (v = 1.6 m/s)
  const samples: RootMotionSample[] = [
    { time: 0, position: [0, 0.9, 0], yaw: 0 },
    { time: 0.25, position: [0, 0.92, 0.4], yaw: 0 },
    { time: 0.5, position: [0, 0.88, 0.8], yaw: 0 },
    { time: 0.75, position: [0, 0.92, 1.2], yaw: 0 },
    { time: 1.0, position: [0, 0.9, 1.6], yaw: 0 },
  ];
  const duration = 1.0;

  // Normal frame step (1/60s)
  const dt = 1 / 60;
  const delta1 = computeRootMotionStepDelta(samples, duration, 0.1, dt, "extract-xz");
  assert.ok(Math.abs(delta1.translation[0]) < 1e-6);
  assert.equal(delta1.translation[1], 0); // extract-xz zeroes Y
  assert.ok(
    Math.abs(delta1.translation[2] - 1.6 * dt) < 1e-4,
    `Expected ~${1.6 * dt}, got ${delta1.translation[2]}`,
  );

  // Exact loop crossing step: from t = 0.95 to t = 0.05 (dt = 0.10s)
  const wrapDelta = computeRootMotionStepDelta(samples, duration, 0.95, 0.1, "extract-xz", {
    isLooping: true,
  });
  // In 0.10s at 1.6m/s, total displacement should be 0.16m
  assert.ok(
    Math.abs(wrapDelta.translation[2] - 0.16) < 1e-4,
    `Expected 0.16m across loop boundary, got ${wrapDelta.translation[2]}`,
  );
  assert.ok(wrapDelta.translation[2] > 0, "Displacement must be positive across wrap (no negative spike)");

  // Multi-loop stepping accumulation: 120 steps of 1/60s = exactly 2.0s = 2 full loops
  let accumulatedZ = 0;
  let t = 0;
  for (let i = 0; i < 120; i++) {
    const step = computeRootMotionStepDelta(samples, duration, t, dt, "extract-xz", {
      isLooping: true,
    });
    accumulatedZ += step.translation[2];
    t = (t + dt) % duration;
  }
  // 2 loops * 1.6m = 3.2m
  assert.ok(
    Math.abs(accumulatedZ - 3.2) < 0.01,
    `Expected 3.2m over 2 full loops, got ${accumulatedZ}`,
  );
});

test("Root Motion: partition invariance under different fixed step sizes", () => {
  const samples: RootMotionSample[] = [
    { time: 0, position: [0, 0, 0], yaw: 0 },
    { time: 0.5, position: [0, 0, 1.0], yaw: 0 },
    { time: 1.0, position: [0, 0, 2.0], yaw: 0 },
  ];
  const duration = 1.0;

  // Run 1: 10 steps of 0.1s
  let sumA = 0;
  let tA = 0;
  for (let i = 0; i < 10; i++) {
    const step = computeRootMotionStepDelta(samples, duration, tA, 0.1, "extract-xz");
    sumA += step.translation[2];
    tA += 0.1;
  }

  // Run 2: 50 steps of 0.02s
  let sumB = 0;
  let tB = 0;
  for (let i = 0; i < 50; i++) {
    const step = computeRootMotionStepDelta(samples, duration, tB, 0.02, "extract-xz");
    sumB += step.translation[2];
    tB += 0.02;
  }

  assert.ok(Math.abs(sumA - 2.0) < 1e-4);
  assert.ok(Math.abs(sumB - 2.0) < 1e-4);
  assert.ok(Math.abs(sumA - sumB) < 1e-5, `Discrepancy: ${sumA} vs ${sumB}`);
});

test("Root Motion: extractRootMotionFromClip creates in-place visual clip and extracts deltas", () => {
  const times = new Float32Array([0, 0.5, 1.0]);
  const positions = new Float32Array([
    0, 0.9, 0,
    0, 0.85, 0.8,
    0, 0.9, 1.6,
  ]);
  const posTrack = new THREE.VectorKeyframeTrack("Hips.position", times, positions);
  const clip = new THREE.AnimationClip("walk_forward", 1.0, [posTrack]);

  const result = extractRootMotionFromClip(clip, {
    mode: "extract-xz",
    rootBoneName: "Hips",
  });
  assert.equal(result.success, true);
  assert.ok(result.extracted);
  assert.equal(result.extracted.mode, "extract-xz");
  assert.ok(Math.abs(result.extracted.totalDisplacement[0]) < 1e-5);
  assert.ok(Math.abs(result.extracted.totalDisplacement[1]) < 1e-5);
  assert.ok(Math.abs(result.extracted.totalDisplacement[2] - 1.6) < 1e-5);

  // Verify visual in-place clip has X and Z locked, but Y preserved
  const inPlaceTrack = result.extracted.inPlaceClip.tracks.find(
    (t) => t.name === "Hips.position",
  ) as THREE.VectorKeyframeTrack;
  assert.ok(inPlaceTrack);
  assert.ok(Math.abs(inPlaceTrack.values[0]! - 0) < 1e-5);
  assert.ok(Math.abs(inPlaceTrack.values[1]! - 0.9) < 1e-5);
  assert.ok(Math.abs(inPlaceTrack.values[2]! - 0) < 1e-5);

  assert.ok(Math.abs(inPlaceTrack.values[3]! - 0) < 1e-5);
  assert.ok(Math.abs(inPlaceTrack.values[4]! - 0.85) < 1e-5); // y1 preserved (hip bobbing!)
  assert.ok(Math.abs(inPlaceTrack.values[5]! - 0) < 1e-5);

  assert.ok(Math.abs(inPlaceTrack.values[6]! - 0) < 1e-5);
  assert.ok(Math.abs(inPlaceTrack.values[7]! - 0.9) < 1e-5); // y2 preserved
  assert.ok(Math.abs(inPlaceTrack.values[8]! - 0) < 1e-5);
});

test("Root Motion Negative Proofs: missing track and malformed samples", () => {
  // 1. Missing root bone track
  const clipNoTrack = new THREE.AnimationClip("empty_clip", 1.0, []);
  const resMissing = extractRootMotionFromClip(clipNoTrack, {
    mode: "extract-xz",
    rootBoneName: "Hips",
  });
  assert.equal(resMissing.success, false);
  assert.equal(resMissing.diagnostics?.code, "animation.rootMotion.trackMissing");
  assert.ok(resMissing.diagnostics?.hint.includes("translation track"));

  // 2. Malformed samples (non-monotonic)
  const badTimes = new Float32Array([0, 0.5, 0.3]); // backwards time!
  const badValues = new Float32Array([0, 0, 0,  0, 0, 1,  0, 0, 2]);
  const badTrack = new THREE.VectorKeyframeTrack("Hips.position", badTimes, badValues);
  const clipBad = new THREE.AnimationClip("bad_clip", 1.0, [badTrack]);
  const resBad = extractRootMotionFromClip(clipBad, {
    mode: "extract-xz",
    rootBoneName: "Hips",
  });
  assert.equal(resBad.success, false);
  assert.equal(resBad.diagnostics?.code, "animation.rootMotion.malformedSamples");
  assert.ok(resBad.diagnostics?.hint.includes("monotonically increasing"));
});

test("Root Motion Inspection: truthfully classifies in-place vs locomotion clips", () => {
  // 1. In-place treadmill walk (similar to CesiumMan: 4mm net displacement over 2.0s)
  const inPlaceTimes = new Float32Array([0, 1.0, 2.0]);
  const inPlaceValues = new Float32Array([
    0.0, -0.02, 0.644,
    0.02, -0.01, 0.680,
    0.0, -0.02, 0.640,
  ]);
  const inPlaceTrack = new THREE.VectorKeyframeTrack("Skeleton_torso_joint_1.position", inPlaceTimes, inPlaceValues);
  const inPlaceClip = new THREE.AnimationClip("treadmill_walk", 2.0, [inPlaceTrack]);

  const reportInPlace = inspectClipRootMotion(inPlaceClip, "Skeleton_torso_joint_1");
  assert.equal(reportInPlace.classification, "in-place");
  assert.equal(reportInPlace.isLocomotion, false);
  assert.ok(reportInPlace.reason.includes("in-place"));

  // 2. Locomotion clip (1.6m forward travel)
  const locoTimes = new Float32Array([0, 1.0]);
  const locoValues = new Float32Array([
    0, 0.9, 0,
    0, 0.9, 1.6,
  ]);
  const locoTrack = new THREE.VectorKeyframeTrack("Hips.position", locoTimes, locoValues);
  const locoClip = new THREE.AnimationClip("forward_walk", 1.0, [locoTrack]);

  const reportLoco = inspectClipRootMotion(locoClip, "Hips");
  assert.equal(reportLoco.classification, "locomotion");
  assert.equal(reportLoco.isLocomotion, true);
  assert.ok(reportLoco.reason.includes("meaningful locomotion translation"));
});
