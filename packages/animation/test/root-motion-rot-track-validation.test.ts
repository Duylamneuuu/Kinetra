/**
 * extractRootMotionFromClip must hold the root ROTATION track to the same contract as the
 * position track: key times finite and non-decreasing, and one [x, y, z, w] value per key.
 * Before, a short quaternion track was read as identity quaternions (a silent yaw of 0) and
 * out-of-order rotation times produced a wrong yaw without any diagnostic (issue #437).
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { extractRootMotionFromClip, type RootMotionMode } from "../src/index.js";

const POS_TIMES = [0, 0.5, 1];
const POS_VALUES = [0, 0, 0, 0, 0, 1, 0, 0, 2];

function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

function clipOf(rotTimes: number[], rotValues: number[]): THREE.AnimationClip {
  return new THREE.AnimationClip("turn", 1, [
    new THREE.VectorKeyframeTrack("Hips.position", POS_TIMES, POS_VALUES),
    new THREE.QuaternionKeyframeTrack("Hips.quaternion", rotTimes, rotValues),
  ]);
}

const MODES: RootMotionMode[] = ["extract-xz", "extract-xyz", "extract-xz-yaw"];

test("a rotation track with fewer values than keys is rejected, not read as identity", () => {
  // Three keys but only two quaternions: the third would silently become (0, 0, 0, 1).
  const values = [...yawQuat(0), ...yawQuat(0.5)];
  for (const mode of MODES) {
    const result = extractRootMotionFromClip(clipOf(POS_TIMES, values), { mode });
    assert.equal(result.success, false, mode);
    assert.equal(result.extracted, undefined, mode);
    assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples", mode);
    assert.match(result.error ?? "", /Hips\.quaternion/);
    assert.match(result.error ?? "", /8 values for 3 keys \(expected 12\)|has 8 values/);
  }
});

test("a rotation track with a partial trailing quaternion is rejected", () => {
  const values = [...yawQuat(0), ...yawQuat(0.5), ...yawQuat(1).slice(0, 3)];
  const result = extractRootMotionFromClip(clipOf(POS_TIMES, values), { mode: "extract-xz-yaw" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
});

test("rotation key times that go backwards are rejected", () => {
  const values = [...yawQuat(0), ...yawQuat(0.5), ...yawQuat(1)];
  const result = extractRootMotionFromClip(clipOf([0, 0.8, 0.4], values), { mode: "extract-xz-yaw" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
  assert.match(result.error ?? "", /Hips\.quaternion/);
  assert.match(result.error ?? "", /index 2/);
});

test("a NaN rotation key time is rejected", () => {
  const values = [...yawQuat(0), ...yawQuat(0.5), ...yawQuat(1)];
  const result = extractRootMotionFromClip(clipOf([0, Number.NaN, 1], values), { mode: "extract-xz-yaw" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
  assert.match(result.error ?? "", /Hips\.quaternion/);
});

test("an Infinity rotation key time is rejected", () => {
  const values = [...yawQuat(0), ...yawQuat(0.5), ...yawQuat(1)];
  const result = extractRootMotionFromClip(clipOf([0, 0.5, Number.POSITIVE_INFINITY], values), {
    mode: "extract-xz-yaw",
  });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
});

test("duplicate rotation key times are still accepted (same rule as the position track)", () => {
  const values = [...yawQuat(0), ...yawQuat(0.5), ...yawQuat(1)];
  const result = extractRootMotionFromClip(clipOf([0, 0.5, 0.5], values), { mode: "extract-xz-yaw" });
  assert.equal(result.success, true);
});

test("a well-formed rotation track with its own (denser) key times still extracts its yaw", () => {
  const rotTimes = [0, 0.25, 0.5, 0.75, 1];
  const values = rotTimes.flatMap((t) => yawQuat(t * 1.2));
  const result = extractRootMotionFromClip(clipOf(rotTimes, values), { mode: "extract-xz-yaw" });
  assert.equal(result.success, true);
  assert.ok(Math.abs((result.extracted?.totalYaw ?? 0) - 1.2) < 1e-4);
});
