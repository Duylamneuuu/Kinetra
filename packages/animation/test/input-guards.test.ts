import assert from "node:assert/strict";
import test from "node:test";
import {
  type AnimationClipMetadata,
  type SkeletonProfile,
  buildRetargetPlan,
  skeletonSignature,
  validateClipMetadata,
  validateSkeletonProfile,
} from "../src/index.js";

const asProfile = (bones: Record<string, unknown>): SkeletonProfile =>
  ({ id: "p", bones }) as unknown as SkeletonProfile;

test("validateSkeletonProfile reports non-string bone names instead of throwing", () => {
  const profile = asProfile({ hips: "Hips", spine: null, head: 42, leftHand: undefined });
  let diagnostics: ReturnType<typeof validateSkeletonProfile> = [];
  assert.doesNotThrow(() => {
    diagnostics = validateSkeletonProfile(profile);
  });
  const empties = diagnostics.filter((d) => d.code === "skeleton.bone.empty").map((d) => d.semanticBone);
  assert.deepEqual(empties.sort(), ["head", "leftHand", "spine"]);
});

test("skeletonSignature ignores unmapped (undefined/null) entries", () => {
  const clean = asProfile({ hips: "Hips", spine: "Spine" });
  const dirty = asProfile({ hips: "Hips", spine: "Spine", head: undefined, leftHand: null });
  assert.equal(skeletonSignature(dirty), skeletonSignature(clean));
});

test("skeletonSignature and retarget plan ordering are locale independent (code point order)", () => {
  // Under ICU collation "B" sorts between "a" and "c"; by code point it sorts first.
  const profile = asProfile({ a: "x", B: "y", c: "z" });
  const plan = buildRetargetPlan(profile, asProfile({ a: "X", B: "Y", c: "Z" }));
  assert.deepEqual(
    plan.pairs.map((p) => p.semantic),
    ["B", "a", "c"],
  );
});

test("buildRetargetPlan treats an undefined/null source bone as unmapped", () => {
  const plan = buildRetargetPlan(
    asProfile({ hips: "SrcHips", spine: undefined, head: null }),
    asProfile({ hips: "Hips", spine: "Spine", head: "Head" }),
  );
  assert.deepEqual(plan.pairs, [{ semantic: "hips", sourceBone: "SrcHips", targetBone: "Hips" }]);
});

const baseClip = (events: unknown): AnimationClipMetadata =>
  ({ id: "c", name: "walk", duration: 2, sourceAssetId: "a", events }) as unknown as AnimationClipMetadata;

test("validateClipMetadata rejects NaN/Infinity event times", () => {
  const issues = validateClipMetadata(
    baseClip([
      { time: Number.NaN, name: "nan" },
      { time: Number.POSITIVE_INFINITY, name: "inf" },
      { time: 1, name: "ok" },
    ]),
  );
  assert.equal(issues.length, 2, issues.join("; "));
  assert.ok(issues.every((i) => i.includes("non-finite")));
});

test("validateClipMetadata rejects Infinity/NaN durations and missing event arrays", () => {
  const inf = validateClipMetadata({ ...baseClip([]), duration: Number.POSITIVE_INFINITY });
  assert.ok(inf.some((i) => i.includes("duration")));
  const nan = validateClipMetadata({ ...baseClip([]), duration: Number.NaN });
  assert.ok(nan.some((i) => i.includes("duration")));
  let issues: string[] = [];
  assert.doesNotThrow(() => {
    issues = validateClipMetadata(baseClip(undefined));
  });
  assert.ok(issues.some((i) => i.includes("events")));
});

test("validateClipMetadata still accepts a sorted in-range clip", () => {
  assert.deepEqual(
    validateClipMetadata(baseClip([{ time: 0, name: "a" }, { time: 2, name: "b" }])),
    [],
  );
});
