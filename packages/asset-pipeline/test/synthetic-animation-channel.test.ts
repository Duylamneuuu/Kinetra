import assert from "node:assert/strict";
import test from "node:test";

import { NodeIO } from "@gltf-transform/core";

import { createSyntheticGlb } from "../src/synthetic.js";

async function readOutput(glb: Uint8Array) {
  const doc = await new NodeIO().readBinary(glb);
  const channel = doc.getRoot().listAnimations()[0]!.listChannels()[0]!;
  const output = channel.getSampler()!.getOutput()!;
  return { path: channel.getTargetPath(), type: output.getType(), array: Array.from(output.getArray()!) };
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
