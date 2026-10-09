import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  type SkeletonProfile,
  RetargetBakeCache,
  bakeRetargetedClip,
  inspectRetargetedClip,
} from "../src/index.js";

// Profiles arrive from JSON / MCP input, so `bones` may be absent or not an object even though
// the static type says otherwise. validateSkeletonProfile and buildRetargetPlan already tolerate
// that; the bake and inspection entry points must report a structured error instead of throwing.
const good: SkeletonProfile = {
  id: "good",
  bones: { hips: "Hips", spine: "Spine", head: "Head" },
};
const noBones = { id: "no-bones" } as unknown as SkeletonProfile;
const nullBones = { id: "null-bones", bones: null } as unknown as SkeletonProfile;
const arrayBones = { id: "array-bones", bones: ["Hips"] } as unknown as SkeletonProfile;

function clip(): THREE.AnimationClip {
  return new THREE.AnimationClip("walk", 1, [
    new THREE.QuaternionKeyframeTrack("Hips.quaternion", [0, 1], [0, 0, 0, 1, 0, 0.7071, 0, 0.7071]),
  ]);
}

for (const [label, bad] of [
  ["missing", noBones],
  ["null", nullBones],
  ["array", arrayBones],
] as const) {
  test(`bakeRetargetedClip reports a diagnostic for a target profile with ${label} bones`, () => {
    let result: ReturnType<typeof bakeRetargetedClip> | undefined;
    assert.doesNotThrow(() => {
      result = bakeRetargetedClip({ sourceClip: clip(), sourceProfile: good, targetProfile: bad });
    });
    assert.equal(result?.success, false);
    assert.ok(result?.diagnostics.some((d) => d.code === "retarget.bone.missing-required"));
  });

  test(`bakeRetargetedClip reports a diagnostic for a source profile with ${label} bones`, () => {
    let result: ReturnType<typeof bakeRetargetedClip> | undefined;
    assert.doesNotThrow(() => {
      result = bakeRetargetedClip({ sourceClip: clip(), sourceProfile: bad, targetProfile: good });
    });
    assert.equal(result?.success, false);
    assert.ok(result?.diagnostics.some((d) => d.code === "retarget.bone.missing-required"));
  });

  test(`inspectRetargetedClip tolerates a target profile with ${label} bones`, () => {
    let result: ReturnType<typeof inspectRetargetedClip> | undefined;
    assert.doesNotThrow(() => {
      result = inspectRetargetedClip(clip(), bad);
    });
    assert.deepEqual(result?.targetBonesAnimated, []);
    assert.deepEqual(result?.unmappedTracks, ["Hips.quaternion"]);
  });

  test(`RetargetBakeCache.getOrBake resolves (not rejects) for a profile with ${label} bones`, async () => {
    const cache = new RetargetBakeCache();
    const result = await cache.getOrBake({ sourceClip: clip(), sourceProfile: good, targetProfile: bad });
    assert.equal(result.success, false);
    assert.ok(result.diagnostics.some((d) => d.code === "retarget.bone.missing-required"));
  });
}
