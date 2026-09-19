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
  assert.throws(()=>db.upsert(record("b",["a"])),/cycle/i);
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
