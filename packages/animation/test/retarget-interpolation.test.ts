import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { type SkeletonProfile, bakeRetargetedClip } from "../src/index.js";

const source: SkeletonProfile = { id: "src", bones: { hips: "SrcHips", spine: "SrcSpine" } };
const target: SkeletonProfile = { id: "tgt", bones: { hips: "Hips", spine: "Spine" } };

const KEYS = [0, 1, 2];
const QUATERNIONS = [0, 0, 0, 1, 0, 0.7071068, 0, 0.7071068, 0, 1, 0, 0];
const POSITIONS = [0, 1, 0, 1, 1, 0, 2, 1, 0];

function find(clip: THREE.AnimationClip, name: string): THREE.KeyframeTrack {
  const track = clip.tracks.find((candidate) => candidate.name === name);
  assert.ok(track, `track ${name} missing: ${clip.tracks.map((t) => t.name).join(", ")}`);
  return track;
}

test("bakeRetargetedClip keeps a step (discrete) rotation track stepped instead of smoothing it", () => {
  const sourceClip = new THREE.AnimationClip("pose-switch", 2, [
    new THREE.QuaternionKeyframeTrack("SrcSpine.quaternion", KEYS, QUATERNIONS, THREE.InterpolateDiscrete),
  ]);
  const result = bakeRetargetedClip({ sourceClip, sourceProfile: source, targetProfile: target });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.equal(find(result.clip!, "Spine.quaternion").getInterpolation(), THREE.InterpolateDiscrete);
});

test("bakeRetargetedClip keeps the interpolation of a baked hips translation track", () => {
  const sourceClip = new THREE.AnimationClip("hop", 2, [
    new THREE.VectorKeyframeTrack("SrcHips.position", KEYS, POSITIONS, THREE.InterpolateDiscrete),
  ]);
  const result = bakeRetargetedClip({
    sourceClip,
    sourceProfile: source,
    targetProfile: target,
    settings: { hipsTranslationPolicy: "preserve" },
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.equal(find(result.clip!, "Hips.position").getInterpolation(), THREE.InterpolateDiscrete);
});

test("bakeRetargetedClip leaves linear and smooth tracks as they were", () => {
  const sourceClip = new THREE.AnimationClip("blend", 2, [
    new THREE.QuaternionKeyframeTrack("SrcSpine.quaternion", KEYS, QUATERNIONS),
    new THREE.VectorKeyframeTrack("SrcHips.position", KEYS, POSITIONS, THREE.InterpolateSmooth),
  ]);
  const result = bakeRetargetedClip({
    sourceClip,
    sourceProfile: source,
    targetProfile: target,
    settings: { hipsTranslationPolicy: "scale", scaleFactor: 2 },
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.equal(find(result.clip!, "Spine.quaternion").getInterpolation(), THREE.InterpolateLinear);
  assert.equal(find(result.clip!, "Hips.position").getInterpolation(), THREE.InterpolateSmooth);
});

test("bakeRetargetedClip skips a track whose values do not match its keys and says so", () => {
  const truncated = new THREE.QuaternionKeyframeTrack("SrcSpine.quaternion", KEYS, QUATERNIONS.slice(0, 8));
  const cubicLike = new THREE.VectorKeyframeTrack("SrcHips.position", KEYS, new Array<number>(KEYS.length * 9).fill(0));
  const good = new THREE.QuaternionKeyframeTrack("SrcHips.quaternion", KEYS, QUATERNIONS);
  const result = bakeRetargetedClip({
    sourceClip: new THREE.AnimationClip("mixed", 2, [truncated, cubicLike, good]),
    sourceProfile: source,
    targetProfile: target,
    settings: { hipsTranslationPolicy: "preserve" },
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.equal(result.trackCount, 1);
  const malformed = result.diagnostics.filter((d) => d.code === "retarget.track.malformed");
  assert.equal(malformed.length, 2, JSON.stringify(result.diagnostics));
  assert.ok(malformed.every((d) => d.severity === "warning"));
  for (const track of result.clip!.tracks) {
    assert.equal(track.values.length, track.times.length * (track.name.endsWith(".position") ? 3 : 4));
    assert.ok(Array.from(track.values).every(Number.isFinite), `${track.name} has non-finite values`);
  }
});

test("bakeRetargetedClip with only malformed tracks fails with no usable tracks", () => {
  const truncated = new THREE.QuaternionKeyframeTrack("SrcSpine.quaternion", KEYS, QUATERNIONS.slice(0, 8));
  const result = bakeRetargetedClip({
    sourceClip: new THREE.AnimationClip("broken", 2, [truncated]),
    sourceProfile: source,
    targetProfile: target,
  });
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "retarget.track.malformed"));
  assert.ok(result.diagnostics.some((d) => d.code === "retarget.clip.no-usable-tracks"));
});
