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

  value.metadata.boundsRadius = -5;
  assert.ok(validateAssetRecord(value).some(d=>d.code==="model.bounds.invalid"));

  value.metadata.boundsRadius = 600;
  assert.ok(validateAssetRecord(value).some(d=>d.code==="model.bounds.large"));

  value.metadata.boundsRadius = 1.5;
  value.metadata.provenance = { provider: "" };
  assert.ok(validateAssetRecord(value).some(d=>d.code==="asset.provenance.provider.empty"));

  value.metadata.provenance = {
    provider: "scenario",
    model: "gpt-6-astra-3d",
    prompt: "sci-fi energy crate",
    creativeUnitsCost: 15,
  };
  assert.ok(!validateAssetRecord(value).some(d=>d.code.startsWith("asset.provenance")));
});

test("validator rejects deterministic synthetic fixture claiming external provider provenance", () => {
  const value = record("synthetic_enemy");

  // Synthetic generator claiming external provider
  value.metadata.provenance = {
    provider: "scenario",
    generator: "createSyntheticCharacterGlb",
    model: "gpt-6-astra-3d-biped",
  };
  const d1 = validateAssetRecord(value);
  assert.ok(d1.some((d) => d.code === "asset.provenance.synthetic.invalidProvider"));

  // Kinetra synthetic claiming external creativeUnitsCost
  value.metadata.provenance = {
    provider: "kinetra",
    generator: "createSyntheticCharacterGlb",
    creativeUnitsCost: 45,
  };
  const d2 = validateAssetRecord(value);
  assert.ok(d2.some((d) => d.code === "asset.provenance.synthetic.externalCost"));

  // Kinetra synthetic claiming external model
  value.metadata.provenance = {
    provider: "kinetra",
    generator: "createSyntheticCharacterGlb",
    model: "gpt-6-astra-3d-biped",
  };
  const d3 = validateAssetRecord(value);
  assert.ok(d3.some((d) => d.code === "asset.provenance.synthetic.externalModel"));

  // Kinetra synthetic claiming external sourceAssetId
  value.metadata.provenance = {
    provider: "kinetra",
    generator: "createSyntheticCharacterGlb",
    sourceAssetId: "scenario_asset_enemy_bot_001",
  };
  const d4 = validateAssetRecord(value);
  assert.ok(d4.some((d) => d.code === "asset.provenance.synthetic.externalAssetId"));

  // Truthful Kinetra synthetic provenance passes with zero provenance diagnostics
  value.metadata.provenance = {
    provider: "kinetra",
    generator: "createSyntheticCharacterGlb",
    license: "MIT",
  };
  const d5 = validateAssetRecord(value);
  assert.ok(!d5.some((d) => d.code.startsWith("asset.provenance")));
});

test("canonical character asset fixture enemy-bot.asset.json has truthful Kinetra synthetic provenance", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join, resolve, dirname } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const { createSyntheticCharacterGlb } = await import("../src/index.js");

  let curr = dirname(fileURLToPath(import.meta.url));
  let candidate = "";
  for (let i = 0; i < 5; i++) {
    const probe = join(curr, "examples/reference-game/assets/characters/enemy-bot.asset.json");
    if (existsSync(probe)) {
      candidate = probe;
      break;
    }
    curr = dirname(curr);
  }
  if (!candidate) {
    candidate = resolve(process.cwd(), "examples/reference-game/assets/characters/enemy-bot.asset.json");
  }
  assert.ok(existsSync(candidate), `enemy-bot.asset.json must exist at ${candidate}`);

  const content = await readFile(candidate, "utf8");
  const parsed = JSON.parse(content) as AssetRecord;

  // Validation must pass with zero errors
  const diagnostics = validateAssetRecord(parsed);
  assert.equal(diagnostics.filter((d) => d.severity === "error").length, 0);

  // Must have truthful synthetic provenance
  const prov = parsed.metadata.provenance;
  assert.ok(prov, "Provenance must be present");
  assert.equal(prov.provider, "kinetra", "Provider must be kinetra, not external provider");
  assert.equal(prov.generator, "createSyntheticCharacterGlb", "Generator must identify synthetic function");
  assert.equal(prov.license, "MIT");

  // Must NOT claim any external provider artifacts
  assert.equal(prov.model, undefined, "Must not claim external model");
  assert.equal(prov.sourceAssetId, undefined, "Must not claim external sourceAssetId");
  assert.equal(prov.creativeUnitsCost, undefined, "Must not claim external Creative Units cost");
  assert.notEqual(prov.provider, "scenario", "Must not claim Scenario provider");

  // Must match hash of createSyntheticCharacterGlb
  const syntheticBytes = await createSyntheticCharacterGlb({ name: "EnemyBot" });
  const syntheticHash = createHash("sha256").update(syntheticBytes).digest("hex");
  assert.equal(parsed.source.contentHash, syntheticHash, "contentHash must match createSyntheticCharacterGlb output");
});

test("canonical prop asset fixture energy-crate.asset.json has truthful Kinetra synthetic provenance and matches createSyntheticPropGlb", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join, resolve, dirname } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const { createSyntheticPropGlb } = await import("../src/index.js");

  let curr = dirname(fileURLToPath(import.meta.url));
  let candidate = "";
  for (let i = 0; i < 5; i++) {
    const probe = join(curr, "examples/reference-game/assets/props/energy-crate.asset.json");
    if (existsSync(probe)) {
      candidate = probe;
      break;
    }
    curr = dirname(curr);
  }
  if (!candidate) {
    candidate = resolve(process.cwd(), "examples/reference-game/assets/props/energy-crate.asset.json");
  }
  assert.ok(existsSync(candidate), `energy-crate.asset.json must exist at ${candidate}`);

  const content = await readFile(candidate, "utf8");
  const parsed = JSON.parse(content) as AssetRecord;

  // Validation must pass with zero errors
  const diagnostics = validateAssetRecord(parsed);
  assert.equal(diagnostics.filter((d) => d.severity === "error").length, 0);

  // Must have truthful synthetic provenance
  const prov = parsed.metadata.provenance;
  assert.ok(prov, "Provenance must be present");
  assert.equal(prov.provider, "kinetra", "Provider must be kinetra, not external provider");
  assert.equal(prov.generator, "createSyntheticPropGlb", "Generator must identify synthetic function");
  assert.equal(prov.license, "MIT");

  // Must NOT claim any external provider artifacts
  assert.equal(prov.model, undefined, "Must not claim external model");
  assert.equal(prov.sourceAssetId, undefined, "Must not claim external sourceAssetId");
  assert.equal(prov.creativeUnitsCost, undefined, "Must not claim external Creative Units cost");
  assert.notEqual(prov.provider, "scenario", "Must not claim Scenario provider");

  // Must match hash of createSyntheticPropGlb({ name: "EnergyCrate" })
  const syntheticBytes = await createSyntheticPropGlb({ name: "EnergyCrate" });
  const syntheticHash = createHash("sha256").update(syntheticBytes).digest("hex");
  assert.equal(parsed.source.contentHash, syntheticHash, "contentHash must match createSyntheticPropGlb output");

  // Check actual .glb file on disk matches hash as well
  const glbPath = join(dirname(candidate), "energy-crate.glb");
  if (existsSync(glbPath)) {
    const glbBytes = await readFile(glbPath);
    const onDiskHash = createHash("sha256").update(glbBytes).digest("hex");
    assert.equal(onDiskHash, syntheticHash, "On-disk energy-crate.glb must match synthetic generator output");
  }
});

test("all repository .asset.json fixtures adhere to provenance truthfulness guardrails", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");

  let repoRoot = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(repoRoot, "pnpm-workspace.yaml"))) break;
    repoRoot = dirname(repoRoot);
  }

  async function findAssetJsonFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await findAssetJsonFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".asset.json")) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const assetFiles = await findAssetJsonFiles(repoRoot);
  assert.ok(assetFiles.length >= 2, `Expected at least 2 .asset.json files in repo, found ${assetFiles.length}`);

  for (const file of assetFiles) {
    const text = await readFile(file, "utf8");
    const record = JSON.parse(text) as AssetRecord;

    // Must validate with 0 errors
    const diagnostics = validateAssetRecord(record);
    const errors = diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], `Asset record ${file} has validation errors: ${JSON.stringify(errors)}`);

    const prov = record.metadata.provenance;
    if (prov) {
      // If fixture is generated locally, it must not claim external provider
      if (record.source.kind === "generated" || prov.generator) {
        assert.notEqual(
          prov.provider,
          "scenario",
          `${file} is a local generated fixture and cannot claim external provider "scenario"`,
        );
        assert.equal(
          prov.creativeUnitsCost,
          undefined,
          `${file} cannot claim external Creative Units cost`,
        );
        assert.equal(
          prov.sourceAssetId,
          undefined,
          `${file} cannot claim external sourceAssetId`,
        );
        assert.equal(
          prov.model,
          undefined,
          `${file} cannot claim external AI model`,
        );
        assert.ok(
          prov.provider === "kinetra" || prov.provider === "kinetra-synthetic" || prov.provider === "synthetic",
          `${file} provider must be kinetra or synthetic, got "${prov.provider}"`,
        );
        assert.ok(
          typeof prov.generator === "string" && prov.generator.length > 0,
          `${file} must specify a generator function/tool`,
        );
      }
    }
  }
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

test("creates deterministic synthetic prop GLB with multiple nodes, meshes, and materials", async () => {
  const { createSyntheticPropGlb } = await import("../src/index.js");
  const bytes = await createSyntheticPropGlb({
    name: "EnergyCrate",
    frameSize: [0.8, 0.8, 0.8],
    coreSize: [0.45, 0.45, 0.45],
  });

  assert.ok(bytes.byteLength > 200);
  const header = inspectGlb(bytes);
  assert.equal(header.magic, 0x46546c67);
  assert.equal(header.version, 2);
  assert.equal(header.length, bytes.byteLength);

  const io = new NodeIO();
  const doc = await io.readBinary(bytes);
  const nodes = doc.getRoot().listNodes();
  assert.equal(nodes.length, 3); // Root, Frame, Core
  const meshes = doc.getRoot().listMeshes();
  assert.equal(meshes.length, 2); // FrameMesh, CoreMesh
  const materials = doc.getRoot().listMaterials();
  assert.equal(materials.length, 2); // FrameMaterial, CoreMaterial
});

test("creates deterministic synthetic rigged character GLB with skin, joints, and 6 gameplay clips", async () => {
  const { createSyntheticCharacterGlb } = await import("../src/index.js");
  const bytes = await createSyntheticCharacterGlb({
    name: "EnemyBot",
  });

  assert.ok(bytes.byteLength > 1000);
  const header = inspectGlb(bytes);
  assert.equal(header.magic, 0x46546c67);
  assert.equal(header.version, 2);
  assert.equal(header.length, bytes.byteLength);

  const io = new NodeIO();
  const doc = await io.readBinary(bytes);

  // Verify skin and joints
  const skins = doc.getRoot().listSkins();
  assert.equal(skins.length, 1);
  const skin = skins[0]!;
  assert.equal(skin.getName(), "EnemyBot_Skin");
  assert.equal(skin.listJoints().length, 7);

  // Verify mesh attributes
  const meshes = doc.getRoot().listMeshes();
  assert.equal(meshes.length, 1);
  const prim = meshes[0]!.listPrimitives()[0]!;
  assert.ok(prim.getAttribute("POSITION"));
  assert.ok(prim.getAttribute("NORMAL"));
  assert.ok(prim.getAttribute("JOINTS_0"));
  assert.ok(prim.getAttribute("WEIGHTS_0"));

  // Verify 6 combat animation clips
  const animations = doc.getRoot().listAnimations();
  assert.equal(animations.length, 6);
  const clipNames = animations.map((a) => a.getName()).sort();
  assert.deepEqual(clipNames, ["attack", "defeat", "hurt", "idle", "telegraph", "walk"]);
});


