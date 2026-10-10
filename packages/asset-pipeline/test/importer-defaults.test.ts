import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetDatabase,
  AssetReimportService,
  GlbDirectImporter,
  PassthroughImporter,
  createSyntheticGlb,
  createSyntheticPropGlb,
  hashBytes,
  importFingerprint,
  type AssetImporterContext,
  type AssetRecord,
  type FileSystemAdapter,
} from "../src/index.js";

function memoryFs(files: Map<string, Uint8Array>): FileSystemAdapter {
  return {
    async readFile(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT ${path}`);
      return bytes.slice();
    },
    async writeFile(path, data) {
      files.set(path, data.slice());
    },
    async rename(from, to) {
      const bytes = files.get(from);
      if (!bytes) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, bytes);
    },
    async unlink(path) {
      files.delete(path);
    },
    async mkdir() {
      return undefined;
    },
  };
}

function record(importer: string, kind: AssetRecord["kind"], metadata: AssetRecord["metadata"]): AssetRecord {
  const recipe = { importer, importerVersion: "1", settings: {} };
  const sourceHash = hashBytes(new Uint8Array([0]));
  return {
    id: "asset",
    kind,
    source: { path: "src/asset.bin", kind: "source", contentHash: sourceHash },
    importedPath: "out/asset.bin",
    recipe,
    fingerprint: importFingerprint({ sourceHash, ...recipe }),
    dependencies: [],
    diagnostics: [],
    metadata,
  };
}

function context(bytes: Uint8Array): AssetImporterContext {
  return {
    assetId: "asset",
    sourcePath: "src/asset.bin",
    sourceBytes: bytes,
    sourceHash: hashBytes(bytes),
    recipe: { importer: "glb", importerVersion: "1", settings: {} },
    targetPath: "out/asset.bin",
  };
}

async function reimport(rec: AssetRecord, source: Uint8Array) {
  const files = new Map<string, Uint8Array>([[rec.source.path, source]]);
  const database = new AssetDatabase();
  database.upsert(rec);
  const service = new AssetReimportService({ database, fileSystem: memoryFs(files) });
  const result = await service.reimport(rec.id);
  return { result, files, database };
}

test("GlbDirectImporter reports the measured bounding-box size, not a fixed 1 m cube", async () => {
  const importer = new GlbDirectImporter();
  const box = await importer.import(context(await createSyntheticGlb({ size: [2, 3, 4] })));
  assert.deepEqual(box.metadata?.dimensions, [2, 3, 4]);

  const orb = await importer.import(context(await createSyntheticGlb({ size: [0.5, 0.5, 0.5] })));
  assert.deepEqual(orb.metadata?.dimensions, [0.5, 0.5, 0.5]);
});

test("the size spans every mesh of the scene", async () => {
  const importer = new GlbDirectImporter();
  const prop = await importer.import(context(await createSyntheticPropGlb({ frameSize: [0.8, 0.4, 0.6] })));
  const [x, y, z] = prop.metadata?.dimensions ?? [];
  assert.ok(Math.abs((x ?? 0) - 0.8) < 1e-6 && Math.abs((y ?? 0) - 0.45) < 1e-6 && Math.abs((z ?? 0) - 0.6) < 1e-6, `${x} ${y} ${z}`);
});

test("reimporting a model through the built-in glb importer replaces dimensions with the measured ones", async () => {
  const glb = await createSyntheticGlb({ size: [0.6, 0.6, 0.6] });
  const { result, database } = await reimport(record("glb", "model", { dimensions: [9, 9, 9] }), glb);
  assert.equal(result.status, "reimported");
  const dimensions = database.get("asset")?.metadata.dimensions ?? [];
  assert.equal(dimensions.length, 3);
  for (const value of dimensions) assert.ok(Math.abs(value - 0.6) < 1e-6, String(value));
});

test("a GLB whose body cannot be parsed keeps the record's own dimensions instead of a made-up 1 m cube", async () => {
  // Valid 12-byte GLB header (magic, version 2, length 12) with no chunks: the header check passes, parsing does not.
  const headerOnly = new Uint8Array(12);
  const view = new DataView(headerOnly.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 12, true);
  const imported = await new GlbDirectImporter().import(context(headerOnly));
  assert.equal(imported.metadata?.dimensions, undefined);

  const { result, database } = await reimport(
    record("glb", "other", { dimensions: [0.6, 0.6, 0.6], boundsRadius: 0.3 }),
    headerOnly,
  );
  assert.equal(result.status, "reimported");
  assert.deepEqual(database.get("asset")?.metadata.dimensions, [0.6, 0.6, 0.6]);
  assert.equal(database.get("asset")?.metadata.boundsRadius, 0.3);
});

test("the built-in passthrough importer copies any bytes unchanged, with no GLB check", async () => {
  const wav = new TextEncoder().encode("RIFF....WAVEfmt  not a glb at all");
  const direct = await new PassthroughImporter().import(context(wav));
  assert.deepEqual(direct.artifactBytes, wav);
  assert.equal(direct.metadata, undefined);

  const { result, files, database } = await reimport(record("passthrough", "audio", { duration: 1.5 }), wav);
  assert.equal(result.status, "reimported", result.error);
  assert.deepEqual(files.get("out/asset.bin"), wav);
  assert.equal(database.get("asset")?.metadata.duration, 1.5);
});
