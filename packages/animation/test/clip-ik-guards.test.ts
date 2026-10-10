import assert from "node:assert/strict";
import test from "node:test";
import {
  type AnimationClipMetadata,
  computeBoneAimRotations,
  rotateVectorByQuat,
  validateClipMetadata,
} from "../src/index.js";

const clip = (patch: Record<string, unknown>): AnimationClipMetadata =>
  ({
    id: "walk",
    name: "Walk",
    duration: 1,
    sourceAssetId: "asset",
    events: [],
    ...patch,
  }) as unknown as AnimationClipMetadata;

test("validateClipMetadata rejects a rootMotionMode outside the documented set", () => {
  const issues = validateClipMetadata(clip({ rootMotionMode: "extract-everything" }));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /rootMotionMode/);
  assert.match(issues[0]!, /extract-xz-yaw/);
});

test("validateClipMetadata accepts every documented rootMotionMode and an omitted one", () => {
  for (const mode of ["none", "extract-xz", "extract-xyz", "extract-xz-yaw"]) {
    assert.deepEqual(validateClipMetadata(clip({ rootMotionMode: mode })), [], mode);
  }
  assert.deepEqual(validateClipMetadata(clip({})), []);
});

test("validateClipMetadata rejects events without a usable name", () => {
  for (const name of [undefined, "", 7, null]) {
    const issues = validateClipMetadata(clip({ events: [{ time: 0.5, name }] }));
    assert.equal(issues.length, 1, `name ${String(name)}`);
    assert.match(issues[0]!, /name/);
  }
});

test("computeBoneAimRotations returns identity, never NaN, for non-finite joint positions", () => {
  const rest: Array<[number, number, number]> = [
    [0, 0, 0],
    [0, 1, 0],
    [0, 2, 0],
  ];
  const poisoned: Array<[number, number, number]> = [
    [0, 0, 0],
    [Number.POSITIVE_INFINITY, 1, 0],
    [0, 2, Number.NaN],
  ];
  for (const [before, after] of [
    [rest, poisoned],
    [poisoned, rest],
  ] as const) {
    const rotations = computeBoneAimRotations(before, after);
    assert.equal(rotations.length, 2);
    for (const q of rotations) {
      assert.ok(q.every(Number.isFinite), `finite quaternion, got ${q.join(",")}`);
      assert.deepEqual([...q], [0, 0, 0, 1]);
    }
  }
});

test("computeBoneAimRotations still aims finite bones next to a poisoned one", () => {
  const before: Array<[number, number, number]> = [
    [0, 0, 0],
    [0, 1, 0],
    [0, 2, 0],
  ];
  const after: Array<[number, number, number]> = [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ];
  const [first, second] = computeBoneAimRotations(before, after);
  assert.deepEqual([...first!], [0, 0, 0, 1]);
  const rotated = rotateVectorByQuat([0, 1, 0], second!);
  assert.ok(Math.abs(rotated[0] - 1) < 1e-9 && Math.abs(rotated[1]) < 1e-9);
});
