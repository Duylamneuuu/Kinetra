import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { type RetargetSettings, type SkeletonProfile, bakeRetargetedClip } from "../src/index.js";

const source: SkeletonProfile = { id: "src", bones: { hips: "SrcHips", spine: "SrcSpine" } };
const target: SkeletonProfile = { id: "tgt", bones: { hips: "Hips", spine: "Spine" } };

function clip(): THREE.AnimationClip {
  return new THREE.AnimationClip("walk", 1, [
    new THREE.QuaternionKeyframeTrack("SrcSpine.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.VectorKeyframeTrack("SrcHips.position", [0, 1], [0, 1, 0, 2, 1, 0]),
  ]);
}

function bake(settings: unknown) {
  return bakeRetargetedClip({
    sourceClip: clip(),
    sourceProfile: source,
    targetProfile: target,
    settings: settings as RetargetSettings,
  });
}

test("bakeRetargetedClip rejects a non-finite or non-positive scaleFactor instead of baking NaN/zeroed hips", () => {
  for (const scaleFactor of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, "2"]) {
    const result = bake({ hipsTranslationPolicy: "scale", scaleFactor });
    assert.equal(result.success, false, `scaleFactor ${String(scaleFactor)} should fail`);
    assert.equal(result.clip, undefined);
    assert.ok(
      result.diagnostics.some((d) => d.severity === "error" && d.code === "retarget.settings.invalid"),
      `scaleFactor ${String(scaleFactor)}: ${JSON.stringify(result.diagnostics)}`,
    );
  }
});

test("bakeRetargetedClip rejects an unknown hipsTranslationPolicy instead of silently preserving translation", () => {
  const result = bake({ hipsTranslationPolicy: "scael" });
  assert.equal(result.success, false);
  const diagnostic = result.diagnostics.find((d) => d.code === "retarget.settings.invalid");
  assert.ok(diagnostic, JSON.stringify(result.diagnostics));
  assert.match(diagnostic.message, /scael/);
});

test("bakeRetargetedClip still accepts every documented policy, a positive scaleFactor and omitted settings", () => {
  for (const hipsTranslationPolicy of ["ignore", "preserve", "relative", "scale"] as const) {
    const result = bake({ hipsTranslationPolicy, scaleFactor: 0.5 });
    assert.equal(result.success, true, `${hipsTranslationPolicy}: ${JSON.stringify(result.diagnostics)}`);
  }
  assert.equal(bake(undefined).success, true);
  assert.equal(bake({}).success, true);
  // Explicit undefined means "default", the same as leaving the key out.
  assert.equal(bake({ hipsTranslationPolicy: undefined, scaleFactor: undefined }).success, true);
});
