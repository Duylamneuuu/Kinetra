import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";

import { stripVisualRootDisplacement } from "../src/root-motion.js";

function stepClip(): THREE.AnimationClip {
  const pos = new THREE.VectorKeyframeTrack(
    "Hips.position",
    [0, 1, 2],
    [0, 0, 0, 1, 0.5, 1, 2, 1, 2],
    THREE.InterpolateDiscrete,
  );
  const rot = new THREE.QuaternionKeyframeTrack(
    "Hips.quaternion",
    [0, 1, 2],
    [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795, 0, 0.7071068, 0, 0.7071068],
    THREE.InterpolateDiscrete,
  );
  return new THREE.AnimationClip("stepped", 2, [pos, rot]);
}

test("stripVisualRootDisplacement keeps the source tracks' interpolation (glTF STEP stays stepped)", () => {
  const stripped = stripVisualRootDisplacement(stepClip(), "Hips", "extract-xz-yaw");
  const pos = stripped.tracks.find((track) => track.name === "Hips.position");
  const rot = stripped.tracks.find((track) => track.name === "Hips.quaternion");
  assert.ok(pos && rot);
  assert.equal(pos.getInterpolation(), THREE.InterpolateDiscrete, "position track interpolation");
  assert.equal(rot.getInterpolation(), THREE.InterpolateDiscrete, "quaternion track interpolation");
});

test("a stepped Y bob stays a step after the root displacement is stripped", () => {
  const stripped = stripVisualRootDisplacement(stepClip(), "Hips", "extract-xz");
  const pos = stripped.tracks.find((track) => track.name === "Hips.position")!;
  // `createInterpolant` is set by three per interpolation mode but is missing from @types/three.
  const interpolant = (pos as unknown as { createInterpolant(): { evaluate(time: number): ArrayLike<number> } }).createInterpolant();
  // Halfway between key 1 (y = 0.5) and key 2 (y = 1): a step holds 0.5, a linear ramp would give 0.75.
  const out = interpolant.evaluate(1.5);
  assert.equal(out[1], 0.5);
});

test("linear tracks stay linear", () => {
  const pos = new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 1, 1, 1]);
  const clip = new THREE.AnimationClip("linear", 1, [pos]);
  const stripped = stripVisualRootDisplacement(clip, "Hips", "extract-xyz");
  assert.equal(stripped.tracks[0]!.getInterpolation(), THREE.InterpolateLinear);
});
