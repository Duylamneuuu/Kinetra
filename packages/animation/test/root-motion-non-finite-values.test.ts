/**
 * A clip whose root-bone keyframe VALUES are NaN/Infinity (or whose position
 * track is shorter than its times) used to extract "successfully": the NaN went
 * straight into the sample table and from there into every entity transform the
 * root-motion step produced. Extraction must reject such a clip with a
 * structured diagnostic instead.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { computeRootMotionStepDelta, extractRootMotionFromClip } from "../src/index.js";

function clipWith(position: number[], quaternion?: number[], times = [0, 0.5, 1]): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack("Hips.position", times, position)];
  if (quaternion) tracks.push(new THREE.QuaternionKeyframeTrack("Hips.quaternion", times, quaternion));
  return new THREE.AnimationClip("walk", 1, tracks);
}

const GOOD_POSITION = [0, 0, 0, 0, 0, 0.5, 0, 0, 1];
const GOOD_QUATERNION = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

test("extractRootMotionFromClip accepts a clip with finite values (control)", () => {
  const result = extractRootMotionFromClip(clipWith(GOOD_POSITION, GOOD_QUATERNION), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  assert.equal(result.success, true);
});

for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`extractRootMotionFromClip rejects a position value of ${bad}`, () => {
    const position = [...GOOD_POSITION];
    position[5] = bad;
    const result = extractRootMotionFromClip(clipWith(position), { mode: "extract-xz", rootBoneName: "Hips" });
    assert.equal(result.success, false);
    assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
    assert.equal(result.extracted, undefined);
  });

  test(`extractRootMotionFromClip rejects a rotation value of ${bad}`, () => {
    const quaternion = [...GOOD_QUATERNION];
    quaternion[6] = bad;
    const result = extractRootMotionFromClip(clipWith(GOOD_POSITION, quaternion), {
      mode: "extract-xz-yaw",
      rootBoneName: "Hips",
    });
    assert.equal(result.success, false);
    assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
  });
}

test("extractRootMotionFromClip rejects a position track with fewer values than keys", () => {
  const result = extractRootMotionFromClip(clipWith([0, 0, 0, 0, 0, 0.5]), {
    mode: "extract-xz",
    rootBoneName: "Hips",
  });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.malformedSamples");
});

test("a successful extraction never yields a non-finite step delta", () => {
  const result = extractRootMotionFromClip(clipWith(GOOD_POSITION, GOOD_QUATERNION), {
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  assert.ok(result.extracted);
  const delta = computeRootMotionStepDelta(result.extracted.samples, 1, 0.1, 0.1, "extract-xz-yaw");
  for (const component of [...delta.translation, delta.yaw]) assert.ok(Number.isFinite(component));
});
