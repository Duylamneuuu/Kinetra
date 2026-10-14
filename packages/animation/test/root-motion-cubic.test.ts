import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  extractRootMotionFromClip,
  inspectClipRootMotion,
  stripVisualRootDisplacement,
} from "../src/root-motion.js";

type CubicFlag = { isInterpolantFactoryMethodGLTFCubicSpline?: boolean };

/**
 * glTF CUBICSPLINE tracks as GLTFLoader builds them: `values` holds, per key, the in-tangent, the
 * value and the out-tangent (3 * valueSize numbers per key) and `createInterpolant` is replaced by a
 * factory flagged `isInterpolantFactoryMethodGLTFCubicSpline`; `getInterpolation()` therefore
 * reports `undefined`.
 */
function markCubicSpline(track: THREE.KeyframeTrack): void {
  const factory = function (): never {
    throw new Error("the interpolant is never built in these tests");
  } as unknown as CubicFlag;
  factory.isInterpolantFactoryMethodGLTFCubicSpline = true;
  (track as unknown as { createInterpolant: unknown }).createInterpolant = factory;
}

const TAN = 9; // a tangent component that must never be read as a position / rotation

function cubicPositionTrack(name: string, positions: Array<[number, number, number]>): THREE.VectorKeyframeTrack {
  const times = positions.map((_, i) => i * 0.5);
  const values: number[] = [];
  for (const [x, y, z] of positions) values.push(TAN, TAN, TAN, x, y, z, TAN, TAN, TAN);
  const track = new THREE.VectorKeyframeTrack(name, times, values);
  markCubicSpline(track);
  return track;
}

function cubicQuaternionTrack(name: string, count: number): THREE.QuaternionKeyframeTrack {
  const times = Array.from({ length: count }, (_, i) => i * 0.5);
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(TAN, TAN, TAN, TAN, 0, 0, 0, 1, TAN, TAN, TAN, TAN);
  const track = new THREE.QuaternionKeyframeTrack(name, times, values);
  markCubicSpline(track);
  return track;
}

function linearPositionTrack(name: string, positions: Array<[number, number, number]>): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(
    name,
    positions.map((_, i) => i * 0.5),
    positions.flat(),
  );
}

const FORWARD: Array<[number, number, number]> = [
  [0, 0.9, 0],
  [0, 0.9, 1],
  [0, 0.9, 2],
];

test("extractRootMotionFromClip rejects a CUBICSPLINE root position track instead of reading tangents as positions", () => {
  const clip = new THREE.AnimationClip("walk", 1, [cubicPositionTrack("Hips.position", FORWARD)]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz", rootBoneName: "Hips" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.unsupportedInterpolation");
  assert.match(result.diagnostics?.message ?? "", /Hips\.position/);
  assert.match(result.diagnostics?.hint ?? "", /LINEAR/);
  assert.equal(result.extracted, undefined);
});

test("extractRootMotionFromClip rejects a CUBICSPLINE root rotation track even when the position track is linear", () => {
  const clip = new THREE.AnimationClip("turn", 1, [
    linearPositionTrack("Hips.position", FORWARD),
    cubicQuaternionTrack("Hips.quaternion", 3),
  ]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz-yaw", rootBoneName: "Hips" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.unsupportedInterpolation");
  assert.match(result.diagnostics?.message ?? "", /Hips\.quaternion/);
});

test("extractRootMotionFromClip also recognises a cubic track by its 3x value layout when the loader flag is gone", () => {
  // A clip that was copied or serialised loses the GLTFLoader createInterpolant flag but keeps the layout.
  const track = cubicPositionTrack("Hips.position", FORWARD);
  const unflagged = new THREE.VectorKeyframeTrack("Hips.position", Array.from(track.times), Array.from(track.values));
  const clip = new THREE.AnimationClip("walk", 1, [unflagged]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz", rootBoneName: "Hips" });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.unsupportedInterpolation");
});

test("extractRootMotionFromClip still accepts a plain LINEAR clip (no false positive on the layout check)", () => {
  const clip = new THREE.AnimationClip("walk", 1, [linearPositionTrack("Hips.position", FORWARD)]);
  const result = extractRootMotionFromClip(clip, { mode: "extract-xz", rootBoneName: "Hips" });
  assert.equal(result.success, true);
  assert.ok(Math.abs((result.extracted?.totalDisplacement[2] ?? 0) - 2) < 1e-6);
});

test("stripVisualRootDisplacement never rewrites a CUBICSPLINE track into garbage", () => {
  const cubic = cubicPositionTrack("Hips.position", FORWARD);
  const clip = new THREE.AnimationClip("walk", 1, [cubic]);
  const stripped = stripVisualRootDisplacement(clip, "Hips", "extract-xz");
  const out = stripped.tracks[0]!;
  assert.deepEqual(Array.from(out.values), Array.from(cubic.values), "cubic keys (tangents included) are kept verbatim");
  assert.deepEqual(Array.from(out.times), Array.from(cubic.times));
  assert.equal(
    (out as unknown as { createInterpolant: CubicFlag }).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline,
    true,
    "the cubic interpolant factory survives, so the clip does not silently become LINEAR",
  );
});

test("stripVisualRootDisplacement keeps the cubic interpolation of the other (non-root) tracks", () => {
  const other = cubicPositionTrack("Spine.position", FORWARD);
  const clip = new THREE.AnimationClip("walk", 1, [linearPositionTrack("Hips.position", FORWARD), other]);
  const stripped = stripVisualRootDisplacement(clip, "Hips", "extract-xz");
  const out = stripped.tracks.find((t) => t.name === "Spine.position")!;
  assert.deepEqual(Array.from(out.values), Array.from(other.values));
  assert.equal(
    (out as unknown as { createInterpolant: CubicFlag }).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline,
    true,
  );
});

test("inspectClipRootMotion reads the VALUE part of each CUBICSPLINE key, not the tangents", () => {
  const clip = new THREE.AnimationClip("walk", 1, [cubicPositionTrack("Hips.position", FORWARD)]);
  const report = inspectClipRootMotion(clip, "Hips");
  assert.deepEqual(report.firstPosition, [0, Math.fround(0.9), 0]);
  assert.deepEqual(report.lastPosition, [0, Math.fround(0.9), 2]);
  assert.ok(Math.abs(report.netDisplacement[2] - 2) < 1e-6, `net Z ${report.netDisplacement[2]}`);
  assert.equal(report.classification, "locomotion");
  assert.match(report.reason, /CUBICSPLINE/);
});
