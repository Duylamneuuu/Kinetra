import assert from "node:assert/strict";
import test from "node:test";

import { NodeIO } from "@gltf-transform/core";

import { createSyntheticGlb } from "../src/synthetic.js";

async function readOutput(glb: Uint8Array) {
  const doc = await new NodeIO().readBinary(glb);
  const channel = doc.getRoot().listAnimations()[0]!.listChannels()[0]!;
  const output = channel.getSampler()!.getOutput()!;
  return { path: channel.getTargetPath(), type: output.getType(), array: Array.from(output.getArray()! as ArrayLike<number>) };
}

test("a rotation channel writes quaternion (VEC4) output, not VEC3", async () => {
  const glb = await createSyntheticGlb({ animation: { property: "rotation" } });
  const { path, type, array } = await readOutput(glb);
  assert.equal(path, "rotation");
  assert.equal(type, "VEC4");
  assert.equal(array.length, 8);
});

test("a rotation channel accepts explicit quaternions", async () => {
  const glb = await createSyntheticGlb({
    animation: { property: "rotation", from: [0, 0, 0, 1], to: [0, 1, 0, 0] },
  });
  const { array } = await readOutput(glb);
  assert.deepEqual(array, [0, 0, 0, 1, 0, 1, 0, 0]);
});

test("a rotation channel rejects 3-component from/to", async () => {
  await assert.rejects(
    () => createSyntheticGlb({ animation: { property: "rotation", from: [0, 0, 0], to: [1, 0, 0] } }),
    /rotation.*4 finite numbers/,
  );
});

test("translation and scale keep VEC3 output and reject non-finite or wrong-arity values", async () => {
  for (const property of ["translation", "scale"] as const) {
    const { type, array } = await readOutput(
      await createSyntheticGlb({ animation: { property, from: [1, 2, 3], to: [4, 5, 6] } }),
    );
    assert.equal(type, "VEC3");
    assert.deepEqual(array, [1, 2, 3, 4, 5, 6]);
  }
  await assert.rejects(
    () => createSyntheticGlb({ animation: { property: "translation", to: [Number.NaN, 0, 0] } }),
    /3 finite numbers/,
  );
  await assert.rejects(
    () => createSyntheticGlb({ animation: { property: "scale", from: [0, 0, 0, 1] } }),
    /3 finite numbers/,
  );
});

test("the default rotation channel goes from identity to a 90 degree turn about Y (VEC4)", async () => {
  const { type, array } = await readOutput(await createSyntheticGlb({ animation: { property: "rotation" } }));
  assert.equal(type, "VEC4");
  const f32 = (value: number): number => Math.fround(value);
  assert.deepEqual(array.slice(0, 4), [0, 0, 0, 1]);
  assert.deepEqual(array.slice(4), [0, f32(Math.SQRT1_2), 0, f32(Math.SQRT1_2)]);
});

test("a non-unit rotation quaternion is normalised before it is written", async () => {
  const { array } = await readOutput(
    await createSyntheticGlb({ animation: { property: "rotation", from: [0, 0, 0, 2], to: [0, 3, 0, 4] } }),
  );
  for (const offset of [0, 4]) {
    const length = Math.hypot(array[offset]!, array[offset + 1]!, array[offset + 2]!, array[offset + 3]!);
    assert.ok(Math.abs(length - 1) < 1e-6, `quaternion at ${offset} has length ${length}`);
  }
  assert.deepEqual(array.slice(0, 4), [0, 0, 0, 1]);
  assert.ok(Math.abs(array[5]! - 0.6) < 1e-6);
  assert.ok(Math.abs(array[7]! - 0.8) < 1e-6);
});

test("a zero-length rotation quaternion is rejected with a clear error", async () => {
  await assert.rejects(
    () => createSyntheticGlb({ animation: { property: "rotation", from: [0, 0, 0, 0] } }),
    /animation\.from is a zero-length quaternion/,
  );
  await assert.rejects(
    () => createSyntheticGlb({ animation: { property: "rotation", to: [0, 0, 0, 0] } }),
    /animation\.to is a zero-length quaternion/,
  );
});

test("translation and scale values are written verbatim, never normalised", async () => {
  const { array } = await readOutput(
    await createSyntheticGlb({ animation: { property: "scale", from: [0, 0, 0], to: [2, 3, 4] } }),
  );
  assert.deepEqual(array, [0, 0, 0, 2, 3, 4]);
});

test("the default rotation channel goes from identity to a 90 degree turn about Y (VEC4)", async () => {
  const { type, array } = await readOutput(await createSyntheticGlb({ animation: { property: "rotation" } }));
  assert.equal(type, "VEC4");
  const f32 = (value: number): number => Math.fround(value);
  assert.deepEqual(array.slice(0, 4), [0, 0, 0, 1]);
  assert.deepEqual(array.slice(4), [0, f32(Math.SQRT1_2), 0, f32(Math.SQRT1_2)]);
});

test("a non-unit rotation quaternion is normalised before it is written", async () => {
  const { array } = await readOutput(
    await createSyntheticGlb({ animation: { property: "rotation", from: [0, 0, 0, 2], to: [0, 3, 0, 4] } }),
  );
  for (const offset of [0, 4]) {
    const length = Math.hypot(array[offset]!, array[offset + 1]!, array[offset + 2]!, array[offset + 3]!);
    assert.ok(Math.abs(length - 1) < 1e-6, `quaternion at ${offset} has length ${length}`);
  }
  assert.deepEqual(array.slice(0, 4), [0, 0, 0, 1]);
  assert.ok(Math.abs(array[5]! - 0.6) < 1e-6);
  assert.ok(Math.abs(array[7]! - 0.8) < 1e-6);
});

test("a zero-length rotation quaternion is rejected with a clear error", async () => {
  await assert.rejects(
    () => createSyntheticGlb({ animation: { property: "rotation", from: [0, 0, 0, 0] } }),
    /animation\.from is a zero-length quaternion/,
  );
  await assert.rejects(
    () => createSyntheticGlb({ animation: { property: "rotation", to: [0, 0, 0, 0] } }),
    /animation\.to is a zero-length quaternion/,
  );
});

test("translation and scale values are written verbatim, never normalised", async () => {
  const { array } = await readOutput(
    await createSyntheticGlb({ animation: { property: "scale", from: [0, 0, 0], to: [2, 3, 4] } }),
  );
  assert.deepEqual(array, [0, 0, 0, 2, 3, 4]);
});
