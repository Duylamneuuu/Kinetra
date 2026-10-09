import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import {
  computeRootMotionStepDelta,
  extractRootMotionFromClip,
} from "../src/root-motion.js";

/** A root bone turning in place through +/-180 degrees: Euler yaw wraps from +pi to -pi mid clip. */
function turningClip(degrees: number[], step = 0.25): THREE.AnimationClip {
  const times = degrees.map((_, index) => index * step);
  const positions = degrees.flatMap((_, index) => [index * 0.1, 0, 0]);
  const quaternions = degrees.flatMap((deg) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    return [q.x, q.y, q.z, q.w];
  });
  return new THREE.AnimationClip("turn", times[times.length - 1] ?? 0, [
    new THREE.VectorKeyframeTrack("Hips.position", times, positions),
    new THREE.QuaternionKeyframeTrack("Hips.quaternion", times, quaternions),
  ]);
}

const deg = (value: number): number => (value * Math.PI) / 180;

test("extractRootMotionFromClip: sample yaw is unwrapped so a turn through 180 degrees stays continuous", () => {
  const result = extractRootMotionFromClip(turningClip([150, 170, 190, 210]), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  assert.equal(result.success, true);
  const samples = result.extracted!.samples;

  for (let i = 1; i < samples.length; i++) {
    const step = samples[i]!.yaw - samples[i - 1]!.yaw;
    assert.ok(Math.abs(step - deg(20)) < 1e-4, `step ${i} should be +20 degrees, got ${step}`);
  }
  assert.ok(Math.abs(result.extracted!.totalYaw - deg(60)) < 1e-4, `totalYaw ${result.extracted!.totalYaw}`);
});

test("computeRootMotionStepDelta: summed yaw over a clip that crosses 180 degrees equals the real turn", () => {
  const extracted = extractRootMotionFromClip(turningClip([150, 170, 190, 210]), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  }).extracted!;

  let total = 0;
  let time = 0;
  const dt = 0.05;
  const steps = Math.round(extracted.duration / dt);
  for (let i = 0; i < steps; i++) {
    const frame = computeRootMotionStepDelta(extracted.samples, extracted.duration, time, dt, "extract-xz-yaw", {
      isLooping: false,
    });
    total += frame.yaw;
    time += dt;
  }
  assert.ok(Math.abs(total - deg(60)) < 1e-3, `summed yaw ${total}`);
});

test("extractRootMotionFromClip: a turn that stays away from the wrap is unchanged", () => {
  const result = extractRootMotionFromClip(turningClip([0, 20, 40, 60]), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  const yaws = result.extracted!.samples.map((sample) => sample.yaw);
  assert.ok(Math.abs(yaws[3]! - deg(60)) < 1e-4);
  assert.ok(Math.abs(result.extracted!.totalYaw - deg(60)) < 1e-4);
});

test("extractRootMotionFromClip: a turn in the negative direction across -180 degrees is unwrapped too", () => {
  const result = extractRootMotionFromClip(turningClip([-150, -170, -190, -210]), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  assert.ok(Math.abs(result.extracted!.totalYaw + deg(60)) < 1e-4, `totalYaw ${result.extracted!.totalYaw}`);
});
