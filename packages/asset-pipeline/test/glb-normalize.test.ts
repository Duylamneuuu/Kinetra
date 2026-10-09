import assert from "node:assert/strict";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { inspectGlb, normalizeGlb } from "../src/index.js";

async function sampleGlb(): Promise<Uint8Array> {
  const document = new Document();
  document.createBuffer();
  const scene = document.createScene("main");
  const parent = document.createNode("parent");
  const child = document.createNode("child").setTranslation([1, 2, 3]);
  parent.addChild(child);
  scene.addChild(parent);
  document.createMaterial("paint").setBaseColorFactor([1, 0, 0, 1]);
  document.createMaterial("glass");
  document.createMesh("empty-mesh");
  document.createAnimation("idle");
  return new NodeIO().writeBinary(document);
}

function withHeader(bytes: Uint8Array, patch: (view: DataView) => void): Uint8Array {
  const copy = new Uint8Array(bytes);
  patch(new DataView(copy.buffer));
  return copy;
}

test("inspectGlb accepts a valid GLB, including a subarray view with a non-zero byteOffset", async () => {
  const glb = await sampleGlb();
  const header = inspectGlb(glb);
  assert.equal(header.version, 2);
  assert.equal(header.length, glb.byteLength);

  const padded = new Uint8Array(glb.byteLength + 7);
  padded.set(glb, 7);
  const view = padded.subarray(7);
  assert.equal(view.byteOffset, 7);
  assert.deepEqual(inspectGlb(view), header);
});

test("inspectGlb rejects truncated, mis-tagged, wrong-version and wrong-length data", async () => {
  const glb = await sampleGlb();

  assert.throws(() => inspectGlb(new Uint8Array(0)), /smaller than its 12-byte header/);
  assert.throws(() => inspectGlb(glb.subarray(0, 11)), /smaller than its 12-byte header/);
  assert.throws(() => inspectGlb(withHeader(glb, (view) => view.setUint32(0, 0x12345678, true))), /Invalid GLB magic/);
  assert.throws(() => inspectGlb(withHeader(glb, (view) => view.setUint32(4, 1, true))), /Unsupported GLB version 1/);
  assert.throws(() => inspectGlb(withHeader(glb, (view) => view.setUint32(4, 3, true))), /Unsupported GLB version 3/);
  assert.throws(() => inspectGlb(glb.subarray(0, glb.byteLength - 4)), /declared length .* does not match/);
  assert.throws(
    () => inspectGlb(withHeader(glb, (view) => view.setUint32(8, glb.byteLength + 1, true))),
    /declared length .* does not match/,
  );
  // Trailing garbage after a declared-length GLB is also a mismatch.
  const trailing = new Uint8Array(glb.byteLength + 4);
  trailing.set(glb);
  assert.throws(() => inspectGlb(trailing), /declared length .* does not match/);
});

test("normalizeGlb reports element counts and sizes for the document it rewrote", async () => {
  const glb = await sampleGlb();
  const result = await normalizeGlb(glb);

  assert.equal(result.beforeBytes, glb.byteLength);
  assert.equal(result.afterBytes, result.bytes.byteLength);
  assert.equal(result.nodeCount, 2);
  assert.equal(result.meshCount, 1);
  assert.equal(result.animationCount, 1);
  assert.equal(result.materialCount, 2);
  assert.equal(result.textureCount, 0);
  assert.equal(inspectGlb(result.bytes).length, result.bytes.byteLength);
});

test("normalizeGlb is idempotent and does not mutate its input", async () => {
  const glb = await sampleGlb();
  const snapshot = new Uint8Array(glb);

  const first = await normalizeGlb(glb);
  assert.deepEqual(glb, snapshot, "input bytes must be untouched");

  const second = await normalizeGlb(first.bytes);
  assert.deepEqual(second.bytes, first.bytes, "normalizing a normalized GLB is a no-op");
  assert.equal(second.nodeCount, first.nodeCount);

  const again = await normalizeGlb(glb);
  assert.deepEqual(again.bytes, first.bytes, "same input gives identical bytes");
});

test("normalizeGlb preserves node hierarchy and transforms", async () => {
  const { bytes } = await normalizeGlb(await sampleGlb());
  const reread = await new NodeIO().readBinary(bytes);
  const child = reread.getRoot().listNodes().find((node) => node.getName() === "child");
  assert.ok(child);
  assert.deepEqual(child.getTranslation(), [1, 2, 3]);
  assert.equal(child.getParentNode()?.getName(), "parent");
});

test("normalizeGlb rejects bytes that are not a GLB instead of returning an empty document", async () => {
  await assert.rejects(() => normalizeGlb(new Uint8Array(0)));
  await assert.rejects(() => normalizeGlb(new TextEncoder().encode("not a glb at all, just text")));
  const glb = await sampleGlb();
  await assert.rejects(() => normalizeGlb(glb.subarray(0, Math.floor(glb.byteLength / 2))));
});
