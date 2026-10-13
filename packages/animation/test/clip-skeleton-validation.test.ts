import assert from "node:assert/strict";
import test from "node:test";
import {
  type AnimationClipMetadata,
  validateClipMetadata,
  validateSkeletonProfile,
} from "../src/index.js";

const clip = (patch: Record<string, unknown>): AnimationClipMetadata =>
  ({
    id: "walk",
    name: "Walk",
    duration: 2,
    sourceAssetId: "asset",
    events: [],
    ...patch,
  }) as unknown as AnimationClipMetadata;

test("validateClipMetadata flags events before 0 or after the clip duration", () => {
  const before = validateClipMetadata(clip({ events: [{ name: "early", time: -0.1 }] }));
  assert.deepEqual(before, ['event "early" is outside clip duration']);
  const after = validateClipMetadata(clip({ events: [{ name: "late", time: 2.5 }] }));
  assert.deepEqual(after, ['event "late" is outside clip duration']);
});

test("validateClipMetadata accepts events exactly at 0 and at the clip duration", () => {
  const issues = validateClipMetadata(
    clip({
      events: [
        { name: "start", time: 0 },
        { name: "end", time: 2 },
      ],
    }),
  );
  assert.deepEqual(issues, []);
});

test("validateClipMetadata reports unsorted events once and stops scanning", () => {
  const issues = validateClipMetadata(
    clip({
      events: [
        { name: "b", time: 1.5 },
        { name: "a", time: 0.5 },
        { name: "c", time: 0.25 },
      ],
    }),
  );
  assert.deepEqual(issues, ["events must be sorted by time"]);
});

test("validateClipMetadata allows several events at the same time", () => {
  const issues = validateClipMetadata(
    clip({
      events: [
        { name: "a", time: 1 },
        { name: "b", time: 1 },
      ],
    }),
  );
  assert.deepEqual(issues, []);
});

test("validateClipMetadata reports a non-finite event time and keeps checking later events", () => {
  for (const time of [Number.NaN, Number.POSITIVE_INFINITY, "1", undefined, null]) {
    const issues = validateClipMetadata(
      clip({
        events: [
          { name: "bad", time },
          { name: "late", time: 9 },
        ],
      }),
    );
    assert.deepEqual(
      issues,
      ['event "bad" has a non-finite time', 'event "late" is outside clip duration'],
      `time ${String(time)}`,
    );
  }
});

test("validateClipMetadata does not compare event times against an invalid duration", () => {
  const issues = validateClipMetadata(clip({ duration: 0, events: [{ name: "x", time: 5 }] }));
  assert.deepEqual(issues, ["clip duration must be a finite positive number"]);
});

test("validateClipMetadata reports every missing field of an empty clip", () => {
  const issues = validateClipMetadata({ events: [] } as unknown as AnimationClipMetadata);
  assert.deepEqual(issues, [
    "clip id is required",
    "clip name is required",
    "clip duration must be a finite positive number",
  ]);
});

test("validateClipMetadata rejects non-object input and missing events array", () => {
  assert.deepEqual(validateClipMetadata(null as unknown as AnimationClipMetadata), [
    "clip must be an object",
  ]);
  assert.deepEqual(validateClipMetadata(42 as unknown as AnimationClipMetadata), [
    "clip must be an object",
  ]);
  const issues = validateClipMetadata(clip({ events: undefined }));
  assert.deepEqual(issues, ["clip events must be an array"]);
});

test("validateSkeletonProfile reports two semantic bones mapped to one physical bone", () => {
  const diagnostics = validateSkeletonProfile({
    bones: { hips: "Hips", spine: "Hips", head: "Head" },
  } as never);
  const duplicates = diagnostics.filter((d) => d.code === "skeleton.bone.duplicate-target");
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]!.severity, "error");
  assert.equal(duplicates[0]!.semanticBone, "spine");
  assert.match(duplicates[0]!.message, /"Hips".*hips.*spine/);
});

test("validateSkeletonProfile reports each further semantic bone sharing a physical bone", () => {
  const diagnostics = validateSkeletonProfile({
    bones: { hips: "B", spine: "B", head: "B" },
  } as never);
  const dup = diagnostics.filter((d) => d.code === "skeleton.bone.duplicate-target");
  assert.deepEqual(dup.map((d) => d.semanticBone), ["spine", "head"]);
});

test("validateSkeletonProfile does not treat an empty mapping as a duplicate of another empty one", () => {
  const diagnostics = validateSkeletonProfile({
    bones: { hips: "", spine: "  ", head: "Head" },
  } as never);
  assert.equal(diagnostics.filter((d) => d.code === "skeleton.bone.duplicate-target").length, 0);
  assert.deepEqual(
    diagnostics.filter((d) => d.code === "skeleton.bone.empty").map((d) => d.semanticBone),
    ["hips", "spine"],
  );
});
