import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetDatabase,
  AssetReimportService,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  type AssetImporter,
  type AssetImporterContext,
  type AssetImporterResult,
  type AssetRecord,
  type FileSystemAdapter,
  type ReimportEvent,
} from "../src/index.js";

class MemoryFs implements FileSystemAdapter {
  readonly files = new Map<string, Uint8Array>();

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return data;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const data = this.files.get(oldPath);
    if (!data) throw new Error(`ENOENT: ${oldPath}`);
    this.files.set(newPath, data);
    this.files.delete(oldPath);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<string | undefined> {
    return path;
  }
}

class ControlledImporter implements AssetImporter {
  shouldFailIds = new Set<string>();

  async import(context: AssetImporterContext): Promise<AssetImporterResult> {
    if (this.shouldFailIds.has(context.assetId)) {
      throw new Error(`Controlled import failure for "${context.assetId}"`);
    }
    return {
      artifactBytes: context.sourceBytes,
      metadata: { dimensions: [1, 1, 1] },
      diagnostics: [],
    };
  }
}

test("Topological Dependency Rebuild Ordering & Cascading Suite", async (t) => {
  await t.test(
    "AssetDatabase: topological rebuild order follows dependencies, not alphabetical sorting (asset_m <- asset_z <- asset_a)",
    () => {
      const db = new AssetDatabase();
      // asset_m is root
      // asset_z depends on asset_m
      // asset_a depends on asset_z
      // Lexical order of dependents is [asset_a, asset_z], which is INVALID because asset_a requires asset_z
      db.upsert({
        id: "asset_m",
        kind: "model",
        source: { path: "m.glb", kind: "source", contentHash: "h_m" },
        importedPath: "imp_m.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_m",
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_z",
        kind: "model",
        source: { path: "z.glb", kind: "source", contentHash: "h_z" },
        importedPath: "imp_z.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_z",
        dependencies: ["asset_m"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_a",
        kind: "model",
        source: { path: "a.glb", kind: "source", contentHash: "h_a" },
        importedPath: "imp_a.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_a",
        dependencies: ["asset_z"],
        diagnostics: [],
        metadata: {},
      });

      // Alphabetical dependentsOf:
      assert.deepEqual(db.dependentsOf("asset_m"), ["asset_a", "asset_z"]);

      // Topological dependentsInRebuildOrder:
      assert.deepEqual(db.dependentsInRebuildOrder("asset_m"), ["asset_z", "asset_a"]);

      // Full rebuildOrder:
      assert.deepEqual(db.rebuildOrder("asset_m"), ["asset_m", "asset_z", "asset_a"]);
    },
  );

  await t.test(
    "AssetDatabase: diamond dependency graph rebuilds root -> [left, right] -> bottom",
    () => {
      const db = new AssetDatabase();
      db.upsert({
        id: "asset_root",
        kind: "model",
        source: { path: "r.glb", kind: "source", contentHash: "h_r" },
        importedPath: "imp_r.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_r",
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_right",
        kind: "model",
        source: { path: "right.glb", kind: "source", contentHash: "h_right" },
        importedPath: "imp_right.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_right",
        dependencies: ["asset_root"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_left",
        kind: "model",
        source: { path: "left.glb", kind: "source", contentHash: "h_left" },
        importedPath: "imp_left.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_left",
        dependencies: ["asset_root"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_bottom",
        kind: "model",
        source: { path: "bot.glb", kind: "source", contentHash: "h_bot" },
        importedPath: "imp_bot.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_bot",
        dependencies: ["asset_left", "asset_right"],
        diagnostics: [],
        metadata: {},
      });

      const order = db.rebuildOrder("asset_root");
      assert.deepEqual(order, ["asset_root", "asset_left", "asset_right", "asset_bottom"]);
    },
  );

  await t.test(
    "reimportWithDependents cascades new fingerprints across dependency chain and leaves unrelated untouched",
    async () => {
      const fs = new MemoryFs();
      const db = new AssetDatabase();
      const importer = new ControlledImporter();
      const events: ReimportEvent[] = [];

      const service = new AssetReimportService({
        database: db,
        fileSystem: fs,
        importers: new Map([["glb", importer]]),
        onEvent: (e) => events.push(e),
      });

      const glbA = await createSyntheticGlb({ size: [1, 1, 1], meshName: "MeshA" });
      const glbB = await createSyntheticGlb({ size: [1, 1, 1], meshName: "MeshB" });
      const glbC = await createSyntheticGlb({ size: [1, 1, 1], meshName: "MeshC" });
      const glbD = await createSyntheticGlb({ size: [1, 1, 1], meshName: "MeshD" });

      await fs.writeFile("src_a.glb", glbA);
      await fs.writeFile("src_b.glb", glbB);
      await fs.writeFile("src_c.glb", glbC);
      await fs.writeFile("src_d.glb", glbD);

      await fs.writeFile("art_a.glb", glbA);
      await fs.writeFile("art_b.glb", glbB);
      await fs.writeFile("art_c.glb", glbC);
      await fs.writeFile("art_d.glb", glbD);

      const hashA = hashBytes(glbA);
      const hashB = hashBytes(glbB);
      const hashC = hashBytes(glbC);
      const hashD = hashBytes(glbD);

      const fA1 = importFingerprint({ sourceHash: hashA, importer: "glb", importerVersion: "1.0", settings: {} });
      const fB1 = importFingerprint({ sourceHash: hashB, importer: "glb", importerVersion: "1.0", settings: {}, dependencyFingerprints: [fA1] });
      const fC1 = importFingerprint({ sourceHash: hashC, importer: "glb", importerVersion: "1.0", settings: {}, dependencyFingerprints: [fB1] });
      const fD1 = importFingerprint({ sourceHash: hashD, importer: "glb", importerVersion: "1.0", settings: {} });

      db.upsert({
        id: "asset_A",
        kind: "model",
        source: { path: "src_a.glb", kind: "source", contentHash: hashA },
        importedPath: "art_a.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: fA1,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_B",
        kind: "model",
        source: { path: "src_b.glb", kind: "source", contentHash: hashB },
        importedPath: "art_b.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: fB1,
        dependencies: ["asset_A"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_C",
        kind: "model",
        source: { path: "src_c.glb", kind: "source", contentHash: hashC },
        importedPath: "art_c.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: fC1,
        dependencies: ["asset_B"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_D",
        kind: "model",
        source: { path: "src_d.glb", kind: "source", contentHash: hashD },
        importedPath: "art_d.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: fD1,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });

      // Modify source of asset_A
      const glbA2 = await createSyntheticGlb({ size: [2, 2, 2], meshName: "MeshA" });
      await fs.writeFile("src_a.glb", glbA2);

      const result = await service.reimportWithDependents("asset_A");

      assert.equal(result.status, "reimported");
      assert.deepEqual(result.rebuildOrder, ["asset_A", "asset_B", "asset_C"]);
      assert.deepEqual(result.rebuiltAssetIds, ["asset_A", "asset_B", "asset_C"]);
      assert.deepEqual(result.blockedAssetIds, []);
      assert.deepEqual(result.unaffectedAssetIds, ["asset_D"]);

      // Verify cascading fingerprints:
      const recA = db.get("asset_A")!;
      const recB = db.get("asset_B")!;
      const recC = db.get("asset_C")!;
      const recD = db.get("asset_D")!;

      assert.notEqual(recA.fingerprint, fA1);
      assert.notEqual(recB.fingerprint, fB1);
      assert.notEqual(recC.fingerprint, fC1);
      assert.equal(recD.fingerprint, fD1); // Untouched!

      // Verify B's fingerprint incorporates A's NEW fingerprint
      const expectedB = importFingerprint({
        sourceHash: hashB,
        importer: "glb",
        importerVersion: "1.0",
        settings: {},
        dependencyFingerprints: [recA.fingerprint],
      });
      assert.equal(recB.fingerprint, expectedB);

      // Verify C's fingerprint incorporates B's NEW fingerprint
      const expectedC = importFingerprint({
        sourceHash: hashC,
        importer: "glb",
        importerVersion: "1.0",
        settings: {},
        dependencyFingerprints: [recB.fingerprint],
      });
      assert.equal(recC.fingerprint, expectedC);

      // Verify events stream
      const eventTypes = events.map((e) => `${e.type}:${e.assetId}`);
      assert.ok(eventTypes.includes("asset.reimportStarted:asset_A"));
      assert.ok(eventTypes.includes("asset.reimportSucceeded:asset_A"));
      assert.ok(eventTypes.includes("asset.dependentReimportStarted:asset_B"));
      assert.ok(eventTypes.includes("asset.dependentReimportSucceeded:asset_B"));
      assert.ok(eventTypes.includes("asset.dependentReimportStarted:asset_C"));
      assert.ok(eventTypes.includes("asset.dependentReimportSucceeded:asset_C"));
    },
  );

  await t.test(
    "reimportWithDependents handles partial failure: root succeeds, dependent B fails, downstream C is blocked",
    async () => {
      const fs = new MemoryFs();
      const db = new AssetDatabase();
      const importer = new ControlledImporter();
      const events: ReimportEvent[] = [];

      const service = new AssetReimportService({
        database: db,
        fileSystem: fs,
        importers: new Map([["glb", importer]]),
        onEvent: (e) => events.push(e),
      });

      const glbA = await createSyntheticGlb({ size: [1, 1, 1] });
      const glbB = await createSyntheticGlb({ size: [1, 1, 1] });
      const glbC = await createSyntheticGlb({ size: [1, 1, 1] });

      await fs.writeFile("src_a.glb", glbA);
      await fs.writeFile("src_b.glb", glbB);
      await fs.writeFile("src_c.glb", glbC);
      await fs.writeFile("art_a.glb", glbA);
      await fs.writeFile("art_b.glb", glbB);
      await fs.writeFile("art_c.glb", glbC);

      db.upsert({
        id: "asset_A",
        kind: "model",
        source: { path: "src_a.glb", kind: "source", contentHash: hashBytes(glbA) },
        importedPath: "art_a.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_a1",
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_B",
        kind: "model",
        source: { path: "src_b.glb", kind: "source", contentHash: hashBytes(glbB) },
        importedPath: "art_b.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_b1",
        dependencies: ["asset_A"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "asset_C",
        kind: "model",
        source: { path: "src_c.glb", kind: "source", contentHash: hashBytes(glbC) },
        importedPath: "art_c.glb",
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: "f_c1",
        dependencies: ["asset_B"],
        diagnostics: [],
        metadata: {},
      });

      // Configure B to fail
      importer.shouldFailIds.add("asset_B");

      // Modify source of A
      const glbA2 = await createSyntheticGlb({ size: [2, 2, 2] });
      await fs.writeFile("src_a.glb", glbA2);

      const result = await service.reimportWithDependents("asset_A");

      assert.equal(result.status, "partial_failure");
      assert.deepEqual(result.rebuiltAssetIds, ["asset_A"]);
      assert.equal(result.failedAssetId, "asset_B");
      assert.deepEqual(result.blockedAssetIds, ["asset_C"]);

      // Verify B and C retain last known good fingerprints
      const recA = db.get("asset_A")!;
      const recB = db.get("asset_B")!;
      const recC = db.get("asset_C")!;

      assert.notEqual(recA.fingerprint, "f_a1");
      assert.equal(recB.fingerprint, "f_b1"); // untouched LKG
      assert.equal(recC.fingerprint, "f_c1"); // untouched LKG

      // Verify events: B emitted failure, C never attempted
      const eventTypes = events.map((e) => `${e.type}:${e.assetId}`);
      assert.ok(eventTypes.includes("asset.reimportSucceeded:asset_A"));
      assert.ok(eventTypes.includes("asset.dependentReimportFailed:asset_B"));
      assert.ok(!eventTypes.some((e) => e.startsWith("asset.dependentReimportStarted:asset_C")));
      assert.ok(!eventTypes.some((e) => e.startsWith("asset.dependentReimportSucceeded:asset_C")));
    },
  );
});
