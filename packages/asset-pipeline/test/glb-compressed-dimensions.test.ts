import assert from "node:assert/strict";
import test from "node:test";

import { GlbDirectImporter, createSyntheticGlb, hashBytes, measureGlbDimensions, type AssetImporterContext } from "../src/index.js";
import { measureGlbBoundsFromJson } from "../src/glb-bounds.js";

const JSON_CHUNK = 0x4e4f534a;

/** Re-encodes a GLB after `edit` rewrote its JSON chunk (binary chunk and chunk padding preserved). */
function editGlbJson(glb: Uint8Array, edit: (json: Record<string, any>) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(view.getUint32(16, true), JSON_CHUNK);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  edit(json);
  let text = JSON.stringify(json);
  while (new TextEncoder().encode(text).byteLength % 4 !== 0) text += " ";
  const encoded = new TextEncoder().encode(text);
  const rest = glb.subarray(20 + jsonLength);
  const out = new Uint8Array(20 + encoded.byteLength + rest.byteLength);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, out.byteLength, true);
  outView.setUint32(12, encoded.byteLength, true);
  outView.setUint32(16, JSON_CHUNK, true);
  out.set(encoded, 20);
  out.set(rest, 20 + encoded.byteLength);
  return out;
}

function context(bytes: Uint8Array): AssetImporterContext {
  return {
    assetId: "asset",
    sourcePath: "src/asset.glb",
    sourceBytes: bytes,
    sourceHash: hashBytes(bytes),
    recipe: { importer: "glb", importerVersion: "1", settings: {} },
    targetPath: "out/asset.glb",
  };
}

function close(actual: readonly number[] | undefined, expected: readonly number[]): void {
  assert.ok(actual, "dimensions were not measured");
  assert.equal(actual.length, 3);
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[axis]! - expected[axis]!) < 1e-6, `${actual} vs ${expected}`);
}

for (const extension of ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_mesh_quantization"]) {
  test(`a GLB that requires ${extension} still reports its dimensions`, async () => {
    const plain = await createSyntheticGlb({ size: [2, 3, 4] });
    const required = editGlbJson(plain, (json) => {
      json.extensionsRequired = [extension];
      json.extensionsUsed = [extension];
    });
    close(await measureGlbDimensions(required), [2, 3, 4]);
    const imported = await new GlbDirectImporter().import(context(required));
    close(imported.metadata?.dimensions, [2, 3, 4]);
    assert.equal(imported.diagnostics, undefined);
  });
}

test("node transforms (scale, translation, rotation) are applied to the declared accessor bounds", async () => {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  const scaled = editGlbJson(plain, (json) => {
    json.extensionsRequired = ["KHR_mesh_quantization"];
    json.nodes[0].scale = [2, 0.5, 1];
    json.nodes[0].translation = [10, 20, 30];
  });
  close(measureGlbBoundsFromJson(scaled), [4, 1.5, 4]);
  // 90 degrees about Y swaps the X and Z extents.
  const rotated = editGlbJson(plain, (json) => {
    json.nodes[0].rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  });
  close(measureGlbBoundsFromJson(rotated), [4, 3, 2]);
});

test("normalized integer accessors are decoded before the node scale is applied", async () => {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  const quantized = editGlbJson(plain, (json) => {
    const position = json.meshes[0].primitives[0].attributes.POSITION;
    json.accessors[position] = { ...json.accessors[position], componentType: 5122, normalized: true, min: [-32767, -16383, -32767], max: [32767, 16383, 32767] };
    json.nodes[0].scale = [1, 2, 4];
  });
  // x: 2 * 1, y: (32766/32767) * 2, z: 2 * 4
  close(measureGlbBoundsFromJson(quantized), [2, (32766 / 32767) * 2, 8]);
});

test("a GLB with no measurable geometry keeps its dimensions and reports a diagnostic instead of staying silent", async () => {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  const noBounds = editGlbJson(plain, (json) => {
    json.extensionsRequired = ["KHR_draco_mesh_compression"];
    for (const accessor of json.accessors) {
      delete accessor.min;
      delete accessor.max;
    }
  });
  assert.equal(await measureGlbDimensions(noBounds), undefined);
  const imported = await new GlbDirectImporter().import(context(noBounds));
  assert.equal(imported.metadata, undefined);
  assert.equal(imported.diagnostics?.length, 1);
  assert.equal(imported.diagnostics?.[0]?.code, "asset.dimensions.unmeasured");
  assert.equal(imported.diagnostics?.[0]?.severity, "warning");
});

test("malformed JSON-chunk contents never throw: cyclic nodes, bad transforms, non-finite bounds, truncated chunks", async () => {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  const cyclic = editGlbJson(plain, (json) => {
    json.nodes[0].children = [0];
  });
  assert.equal(measureGlbBoundsFromJson(cyclic), undefined);
  const zeroQuaternion = editGlbJson(plain, (json) => {
    json.nodes[0].rotation = [0, 0, 0, 0];
  });
  assert.equal(measureGlbBoundsFromJson(zeroQuaternion), undefined);
  const badMatrix = editGlbJson(plain, (json) => {
    json.nodes[0].matrix = [1, 2, 3];
  });
  assert.equal(measureGlbBoundsFromJson(badMatrix), undefined);
  const nonNumeric = editGlbJson(plain, (json) => {
    json.accessors[json.meshes[0].primitives[0].attributes.POSITION].max = ["a", 1, 1];
  });
  assert.equal(measureGlbBoundsFromJson(nonNumeric), undefined);
  assert.equal(measureGlbBoundsFromJson(plain.subarray(0, 30)), undefined);
  assert.equal(measureGlbBoundsFromJson(new Uint8Array(0)), undefined);
  assert.equal(measureGlbBoundsFromJson(new Uint8Array(40).fill(0xff)), undefined);
});

test("an unnormalized byte/short position accessor is reported in its own units and a normalized float type is rejected", async () => {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  const badNormalized = editGlbJson(plain, (json) => {
    const position = json.meshes[0].primitives[0].attributes.POSITION;
    json.accessors[position] = { ...json.accessors[position], componentType: 5126, normalized: true };
  });
  assert.equal(measureGlbBoundsFromJson(badNormalized), undefined);
});
