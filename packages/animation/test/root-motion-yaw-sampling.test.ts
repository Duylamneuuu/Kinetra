/**
 * Root yaw is sampled at the union of the position and rotation key times, and measured as
 * the twist about +Y (stable near pitch +/-90 degrees) instead of an Euler YXZ angle.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { extractRootMotionFromClip, inspectClipRootMotion } from "../src/index.js";

function yawQuat(yaw: number, pitch = 0): number[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
  return [q.x, q.y, q.z, q.w];
}

function clipOf(
  posTimes: number[],
  posValues: number[],
  rotTimes: number[],
  rotValues: number[],
  duration: number,
): THREE.AnimationClip {
  return new THREE.AnimationClip("turn", duration, [
    new THREE.VectorKeyframeTrack("Hips.position", posTimes, posValues),
    new THREE.QuaternionKeyframeTrack("Hips.quaternion", rotTimes, rotValues),
  ]);
}

test("a full turn between two position keys is not lost (rotation track denser than position)", () => {
  // Position keys only at 0 and 1; the rotation turns 0 -> 120 -> 240 -> 360 degrees in between.
  const deg = Math.PI / 180;
  const clip = clipOf(
    [0, 1],
    [0, 0, 0, 0, 0, 1],
    [0, 1 / 3, 2 / 3, 1],
    [...yawQuat(0), ...yawQuat(120 * deg), ...yawQuat(240 * deg), ...yawQuat(360 * deg)],
    1,
  );
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz-yaw", rootBoneName: "Hips" });
  assert.equal(result.success, true);
  assert.ok(Math.abs(result.extracted!.totalYaw - 2 * Math.PI) < 1e-3, `totalYaw ${result.extracted!.totalYaw}`);
  assert.ok(result.extracted!.samples.length >= 4, "rotation key times must produce samples");
  const inspected = inspectClipRootMotion(clip, "Hips");
  assert.ok(Math.abs(inspected.netYaw - 2 * Math.PI) < 1e-3, `netYaw ${inspected.netYaw}`);
});

test("positions of the extra rotation-time samples lie on the position track", () => {
  const clip = clipOf(
    [0, 1],
    [0, 0, 0, 0, 0, 2],
    [0, 0.5, 1],
    [...yawQuat(0), ...yawQuat(0.5), ...yawQuat(1)],
    1,
  );
  const { extracted } = extractRootMotionFromClip(clip, { mode: "extract-xz-yaw", rootBoneName: "Hips" });
  const mid = extracted!.samples.find((s) => s.time === 0.5);
  assert.ok(mid, "a sample at the rotation key time 0.5");
  assert.ok(Math.abs(mid!.position[2] - 1) < 1e-6);
  assert.ok(Math.abs(mid!.yaw - 0.5) < 1e-6);
});

test("yaw does not jump when the pitch approaches +/-90 degrees", () => {
  const yaw = 0.7;
  const rotTimes = [0, 0.25, 0.5, 0.75, 1];
  // Same heading, pitch sweeping through the gimbal-lock singularity of Euler YXZ.
  const pitches = [0, Math.PI / 4, Math.PI / 2 - 1e-4, Math.PI / 2, -Math.PI / 2];
  const rotValues = pitches.flatMap((p) => yawQuat(yaw, p));
  const clip = clipOf(rotTimes, rotTimes.flatMap((t) => [0, 0, t]), rotTimes, rotValues, 1);
  const { extracted } = extractRootMotionFromClip(clip, { mode: "extract-xz-yaw", rootBoneName: "Hips" });
  for (const sample of extracted!.samples) {
    assert.ok(Math.abs(sample.yaw - yaw) < 1e-3, `yaw at t=${sample.time} was ${sample.yaw}, expected ${yaw}`);
  }
  assert.ok(Math.abs(extracted!.totalYaw) < 1e-3);
  assert.ok(Math.abs(inspectClipRootMotion(clip, "Hips").netYaw) < 1e-3);
});

test("a pure heading change is reported exactly", () => {
  const clip = clipOf([0, 1], [0, 0, 0, 0, 0, 1], [0, 1], [...yawQuat(0.2), ...yawQuat(1.2)], 1);
  const { extracted } = extractRootMotionFromClip(clip, { mode: "extract-xz-yaw", rootBoneName: "Hips" });
  assert.ok(Math.abs(extracted!.totalYaw - 1) < 1e-6);
});
