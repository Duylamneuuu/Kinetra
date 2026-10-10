import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { extractRootMotionFromClip, inspectClipRootMotion } from "../src/root-motion.js";

const deg = (value: number): number => (value * Math.PI) / 180;

function yawValues(degrees: number[]): number[] {
  return degrees.flatMap((value) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg(value));
    return [q.x, q.y, q.z, q.w];
  });
}

function clipWith(posTimes: number[], rotTimes: number[], rotDegrees: number[]): THREE.AnimationClip {
  const duration = Math.max(posTimes[posTimes.length - 1] ?? 0, rotTimes[rotTimes.length - 1] ?? 0);
  return new THREE.AnimationClip("turn", duration, [
    new THREE.VectorKeyframeTrack(
      "Hips.position",
      posTimes,
      posTimes.flatMap((_, index) => [index * 0.5, 0, 0]),
    ),
    new THREE.QuaternionKeyframeTrack("Hips.quaternion", rotTimes, yawValues(rotDegrees)),
  ]);
}

test("extractRootMotionFromClip: yaw is sampled at the position key's time when the rotation track has fewer keys", () => {
  // Rotation keys only at t=0 and t=2 (0 -> 80 degrees); position keys at 0, 1, 2.
  const result = extractRootMotionFromClip(clipWith([0, 1, 2], [0, 2], [0, 80]), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  assert.equal(result.success, true);
  const yaws = result.extracted!.samples.map((s) => s.yaw);
  assert.ok(Math.abs(yaws[0]! - deg(0)) < 1e-4, `yaw@0 ${yaws[0]}`);
  assert.ok(Math.abs(yaws[1]! - deg(40)) < 1e-4, `yaw@1 should be halfway (40deg), got ${yaws[1]}`);
  assert.ok(Math.abs(yaws[2]! - deg(80)) < 1e-4, `yaw@2 ${yaws[2]}`);
});

test("extractRootMotionFromClip: yaw is sampled by time when the rotation track has more keys than the position track", () => {
  // Position keys at 0 and 1; rotation keys every 0.25 s swinging out to 90 degrees and back to 0.
  const result = extractRootMotionFromClip(
    clipWith([0, 1], [0, 0.25, 0.5, 0.75, 1], [0, 45, 90, 45, 0]),
    { mode: "extract-xz-yaw", rootBoneName: "Hips" },
  );
  assert.equal(result.success, true);
  const yaws = result.extracted!.samples.map((s) => s.yaw);
  assert.ok(Math.abs(yaws[1]! - deg(0)) < 1e-4, `yaw@1 should be back at 0, got ${yaws[1]}`);
  assert.ok(Math.abs(result.extracted!.totalYaw) < 1e-4, `totalYaw ${result.extracted!.totalYaw}`);
});

test("extractRootMotionFromClip: rotation keys offset in time are interpolated and held at the ends", () => {
  // Rotation starts at t=0.5 (yaw 20) and ends at t=1.5 (yaw 60); position keys at 0, 1, 2.
  const result = extractRootMotionFromClip(clipWith([0, 1, 2], [0.5, 1.5], [20, 60]), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  const yaws = result.extracted!.samples.map((s) => s.yaw);
  assert.ok(Math.abs(yaws[0]! - deg(20)) < 1e-4, `before the first key holds it, got ${yaws[0]}`);
  assert.ok(Math.abs(yaws[1]! - deg(40)) < 1e-4, `midway between keys, got ${yaws[1]}`);
  assert.ok(Math.abs(yaws[2]! - deg(60)) < 1e-4, `after the last key holds it, got ${yaws[2]}`);
});

test("inspectClipRootMotion: netYaw reports the real turn of the root bone", () => {
  const report = inspectClipRootMotion(clipWith([0, 1, 2], [0, 1, 2], [0, 30, 90]), "Hips");
  assert.ok(Math.abs(report.netYaw - deg(90)) < 1e-4, `netYaw ${report.netYaw}`);
  const none = inspectClipRootMotion(clipWith([0, 1], [0, 1], [10, 10]), "Hips");
  assert.ok(Math.abs(none.netYaw) < 1e-6, `netYaw ${none.netYaw}`);
});
