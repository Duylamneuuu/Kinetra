import assert from "node:assert/strict";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  AssetDatabase,
  importFingerprint,
  inspectGlb,
  validateAssetRecord,
  type AssetRecord,
} from "../src/index.js";

function record(id: string, dependencies: string[] = []): AssetRecord {
  const sourceHash = "a".repeat(64);
  const recipe = { importer:"blender-glb", importerVersion:"1", settings:{ applyModifiers:true } };
  return {
    id,
    kind:"model",
    source:{ path:`assets/source/${id}.blend`, kind:"source", contentHash:sourceHash },
    importedPath:`assets/imported/${id}.glb`,
    recipe,
    fingerprint:importFingerprint({
      sourceHash,
      importer:recipe.importer,
      importerVersion:recipe.importerVersion,
      settings:recipe.settings,
    }),
    dependencies,
    diagnostics:[],
    metadata:{ polycount:1200 },
  };
}

test("fingerprint is deterministic across settings key order", () => {
  const a=importFingerprint({sourceHash:"a".repeat(64), importer:"x", importerVersion:"1", settings:{b:2,a:1}});
  const b=importFingerprint({sourceHash:"a".repeat(64), importer:"x", importerVersion:"1", settings:{a:1,b:2}});
  assert.equal(a,b);
});

test("database computes transitive invalidation set", () => {
  const db=new AssetDatabase();
  db.upsert(record("texture"));
  db.upsert(record("material",["texture"]));
  db.upsert(record("character",["material"]));
  assert.deepEqual(db.invalidationSet("texture"),["texture","character","material"]);
});

test("database rejects dependency cycles", () => {
  const db=new AssetDatabase();
  db.upsert(record("a",["b"]));
  assert.throws(
    () => db.upsert(record("b",["a"])),
    /Asset dependency cycle detected: a -> b -> a\./,
  );
});

test("database caps long dependency cycle paths at 12 assets", () => {
  const db=new AssetDatabase();
  const ids = Array.from({ length: 13 }, (_, index) => `asset-${String(index).padStart(2, "0")}`);
  for (let index = 0; index < ids.length - 1; index += 1) {
    db.upsert(record(ids[index]!, [ids[index + 1]!]));
  }
  assert.throws(
    () => db.upsert(record(ids[12]!, [ids[0]!])),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const shown = ids.slice(0, 12).join(" -> ");
      assert.equal(
        error.message,
        `Asset dependency cycle detected: ${shown}, and 1 more, returning to ${ids[0]}.`,
      );
      return true;
    },
  );
});

test("validator emits structured policy diagnostics", () => {
  const value=record("hero");
  value.metadata.polycount=3_000_000;
  assert.ok(validateAssetRecord(value).some(d=>d.code==="model.polycount.high"));
});

test("GLB header validation rejects malformed files and accepts v2 header", () => {
  const bytes=new Uint8Array(12);
  const view=new DataView(bytes.buffer);
  view.setUint32(0,0x46546c67,true);
  view.setUint32(4,2,true);
  view.setUint32(8,12,true);
  assert.deepEqual(inspectGlb(bytes),{magic:0x46546c67,version:2,length:12});
  bytes[0]=0;
  assert.throws(()=>inspectGlb(bytes),/magic/i);
});


test("normalizes a generated GLB through glTF-Transform", async () => {
  const { normalizeGlb } = await import("../src/index.js");
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Main");
  const node = document.createNode("UnusedNode");
  scene.addChild(node);

  const io = new NodeIO();
  const input = await io.writeBinary(document);
  const result = await normalizeGlb(input);

  assert.ok(result.bytes.byteLength > 12);
  assert.equal(result.beforeBytes, input.byteLength);
  assert.equal(inspectGlb(result.bytes).version, 2);
  assert.ok(result.afterBytes > 0);
  void buffer;
});

test("creates deterministic synthetic GLB with valid v2 header and non-empty payload", async () => {
  const { createSyntheticGlb } = await import("../src/index.js");
  const bytes = await createSyntheticGlb({
    meshName: "CustomMesh",
    nodeName: "CustomNode",
    materialName: "CustomMat",
    size: [2, 3, 4],
  });

  assert.ok(bytes.byteLength > 100);
  const header = inspectGlb(bytes);
  assert.equal(header.magic, 0x46546c67);
  assert.equal(header.version, 2);
  assert.equal(header.length, bytes.byteLength);
});

test("creates deterministic synthetic animated GLB with animation clip", async () => {
  const { createSyntheticAnimatedGlb } = await import("../src/index.js");
  const bytes = await createSyntheticAnimatedGlb({
    clipName: "MoveX",
    duration: 1.0,
  });

  assert.ok(bytes.byteLength > 100);
  const header = inspectGlb(bytes);
  assert.equal(header.magic, 0x46546c67);
  assert.equal(header.version, 2);

  const io = new NodeIO();
  const doc = await io.readBinary(bytes);
  const animations = doc.getRoot().listAnimations();
  assert.equal(animations.length, 1);
  assert.equal(animations[0]!.getName(), "MoveX");

  const channels = animations[0]!.listChannels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0]!.getTargetPath(), "translation");
  assert.equal(channels[0]!.getTargetNode()!.getName(), "AnimatedBoxNode");
});

