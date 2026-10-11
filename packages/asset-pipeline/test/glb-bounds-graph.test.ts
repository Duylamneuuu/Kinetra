import assert from "node:assert/strict";
import test from "node:test";

import { GlbDirectImporter, createSyntheticGlb, hashBytes, type AssetImporterContext } from "../src/index.js";
import { glbDeclaresMeshes, measureGlbBoundsFromJson } from "../src/glb-bounds.js";

// Follow-up to #355 (issue #367 items 1-2): the JSON-only bounds fallback must not walk a malformed
// node DAG exponentially, and a valid GLB with no geometry (animation-only, empty nodes) must not get
// an `asset.dimensions.unmeasured` warning on every import.

const JSON_CHUNK = 0x4e4f534a;

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

/** Chain of `depth` empty nodes where every node lists the next one twice; the last one holds the mesh. */
async function diamondChain(depth: number): Promise<Uint8Array> {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  return editGlbJson(plain, (json) => {
    // Force the JSON-only path the way a Draco/meshopt file would.
    json.extensionsRequired = ["KHR_mesh_quantization"];
    const meshIndex = json.nodes[0].mesh;
    const nodes: Array<Record<string, unknown>> = [];
    for (let index = 0; index < depth; index++) nodes.push({ children: [index + 1, index + 1] });
    nodes.push({ mesh: meshIndex });
    json.nodes = nodes;
    json.scenes = [{ nodes: [0] }];
    json.scene = 0;
  });
}

test("a node DAG that shares children is unmeasurable instead of being walked 2^depth times", async () => {
  // 2^16 paths: measured (wrongly treated as a tree) before the fix, rejected after.
  assert.equal(measureGlbBoundsFromJson(await diamondChain(16)), undefined);
});

test("a deep diamond chain returns promptly", async () => {
  const bytes = await diamondChain(200);
  const started = performance.now();
  assert.equal(measureGlbBoundsFromJson(bytes), undefined);
  assert.ok(performance.now() - started < 1000, "bounds walk did not stop early");
});

test("a node reachable from two scenes is still measured (each scene is its own tree)", async () => {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  const twoScenes = editGlbJson(plain, (json) => {
    json.extensionsRequired = ["KHR_mesh_quantization"];
    json.scenes = [{ nodes: [0] }, { nodes: [0] }];
  });
  const size = measureGlbBoundsFromJson(twoScenes);
  assert.ok(size);
  assert.deepEqual(size.map((value) => Math.round(value * 1e6) / 1e6), [2, 3, 4]);
});

test("a cyclic hierarchy is unmeasurable", async () => {
  const plain = await createSyntheticGlb({ size: [2, 3, 4] });
  const cyclic = editGlbJson(plain, (json) => {
    json.extensionsRequired = ["KHR_mesh_quantization"];
    json.nodes.push({ children: [json.nodes.length] });
    json.nodes[0].children = [json.nodes.length - 1];
  });
  assert.equal(measureGlbBoundsFromJson(cyclic), undefined);
});

test("glbDeclaresMeshes reads the JSON chunk", async () => {
  const plain = await createSyntheticGlb({ size: [1, 1, 1] });
  assert.equal(glbDeclaresMeshes(plain), true);
  const empty = editGlbJson(plain, (json) => {
    delete json.meshes;
    for (const node of json.nodes) delete node.mesh;
  });
  assert.equal(glbDeclaresMeshes(empty), false);
  assert.equal(glbDeclaresMeshes(new Uint8Array(4)), false);
});

test("a GLB without meshes imports without an unmeasured-dimensions warning", async () => {
  const plain = await createSyntheticGlb({ size: [1, 1, 1] });
  const animationOnly = editGlbJson(plain, (json) => {
    delete json.meshes;
    for (const node of json.nodes) delete node.mesh;
  });
  const result = await new GlbDirectImporter().import(context(animationOnly));
  assert.equal(result.metadata?.dimensions, undefined);
  assert.equal(result.diagnostics?.some((d) => d.code === "asset.dimensions.unmeasured") ?? false, false);
});

test("a GLB with meshes that cannot be measured still warns", async () => {
  const plain = await createSyntheticGlb({ size: [1, 1, 1] });
  const noMinMax = editGlbJson(plain, (json) => {
    json.extensionsRequired = ["KHR_mesh_quantization"];
    for (const accessor of json.accessors) {
      delete accessor.min;
      delete accessor.max;
    }
  });
  const result = await new GlbDirectImporter().import(context(noMinMax));
  assert.equal(result.metadata?.dimensions, undefined);
  assert.equal(result.diagnostics?.[0]?.code, "asset.dimensions.unmeasured");
});
