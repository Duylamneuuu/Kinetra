import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AssetDatabase,
  AssetHotReloadCoordinator,
  AssetReimportService,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  SourceAssetWatcher,
  type ReimportEvent,
  type RuntimeReloadTarget,
} from "../src/index.js";

class MockRuntimeTarget implements RuntimeReloadTarget {
  readonly updatedAssets = new Map<string, { base64: string; options?: any }>();
  readonly reloadedAssets: string[] = [];
  entities = [
    { entityId: "ent_worker_1", model: { assetId: "asset_box" } },
    { entityId: "ent_worker_2", model: { assetId: "asset_box" } },
    { entityId: "ent_prop_unrelated", model: { assetId: "asset_other" } },
  ];

  async updateAsset(assetId: string, dataBase64: string, options?: any): Promise<void> {
    this.updatedAssets.set(assetId, { base64: dataBase64, options });
  }

  async reloadAsset(assetId: string): Promise<{ success: boolean; affectedEntities: string[]; error?: string }> {
    this.reloadedAssets.push(assetId);
    const affected = this.entities
      .filter((e) => e.model?.assetId === assetId)
      .map((e) => e.entityId);
    return {
      success: true,
      affectedEntities: affected,
    };
  }

  async queryEntities(): Promise<Array<{ entityId: string; model?: { assetId?: string } }>> {
    return this.entities;
  }
}

test("AssetHotReloadCoordinator Integration Suite", async (t) => {
  let tempDir: string;

  t.beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kinetra-coordinator-test-"));
  });

  t.afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await t.test(
    "watcher drives full pipeline: change detected -> reimport -> runtime update -> live reload without manual glue",
    async () => {
      const sourcePath = join(tempDir, "box.glb");
      const artifactPath = join(tempDir, "imported_box.glb");

      const glbV1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: "BoxMesh" });
      await writeFile(sourcePath, glbV1);
      await writeFile(artifactPath, glbV1);

      const hashV1 = hashBytes(glbV1);
      const f1 = importFingerprint({ sourceHash: hashV1, importer: "glb", importerVersion: "1.0", settings: {} });

      const db = new AssetDatabase();
      db.upsert({
        id: "asset_box",
        kind: "model",
        source: { path: sourcePath, kind: "source", contentHash: hashV1 },
        importedPath: artifactPath,
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: f1,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });

      const reimportService = new AssetReimportService({ database: db });
      const watcher = new SourceAssetWatcher({ debounceMs: 40 });
      watcher.addAsset("asset_box", sourcePath, hashV1);

      const runtimeTarget = new MockRuntimeTarget();
      const events: ReimportEvent[] = [];

      const coordinator = new AssetHotReloadCoordinator({
        database: db,
        reimportService,
        watcher,
        runtimeTarget,
        onEvent: (e) => events.push(e),
      });

      await coordinator.start();
      assert.ok(coordinator.isStarted());

      // Setup promise to wait for transaction triggered by watcher
      const txPromise = coordinator.waitForAssetReload("asset_box", 5000);

      // Write v2 bytes to source file
      const glbV2 = await createSyntheticGlb({ size: [3, 2, 1], meshName: "BoxMesh" });
      await writeFile(sourcePath, glbV2);

      // Wait for coordinator to execute the entire transaction
      const tx = await txPromise;

      assert.equal(tx.rootAssetId, "asset_box");
      assert.notEqual(tx.newFingerprint, f1);
      assert.deepEqual(tx.rebuiltAssetIds, ["asset_box"]);
      assert.deepEqual(tx.runtimeReloadedEntityIds, ["ent_worker_1", "ent_worker_2"]);
      assert.deepEqual(tx.runtimeUnchangedEntityIds, ["ent_prop_unrelated"]);

      // Verify runtime target was automatically updated and reloaded
      assert.ok(runtimeTarget.updatedAssets.has("asset_box"));
      assert.deepEqual(runtimeTarget.reloadedAssets, ["asset_box"]);

      // Verify event ordering
      const eventTypes = events.map((e) => e.type);
      assert.ok(eventTypes.includes("asset.changeDetected"));
      assert.ok(eventTypes.includes("asset.reimportStarted"));
      assert.ok(eventTypes.includes("asset.reimportSucceeded"));
      assert.ok(eventTypes.includes("asset.runtimeReloadStarted"));
      assert.ok(eventTypes.includes("asset.runtimeReloadSucceeded"));

      await coordinator.stop();
      assert.equal(coordinator.isStarted(), false);
    },
  );

  await t.test(
    "touch only / unchanged content hash produces NO reload transaction",
    async () => {
      const sourcePath = join(tempDir, "box.glb");
      const artifactPath = join(tempDir, "imported_box.glb");

      const glbV1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: "BoxMesh" });
      await writeFile(sourcePath, glbV1);
      await writeFile(artifactPath, glbV1);

      const hashV1 = hashBytes(glbV1);
      const f1 = importFingerprint({ sourceHash: hashV1, importer: "glb", importerVersion: "1.0", settings: {} });

      const db = new AssetDatabase();
      db.upsert({
        id: "asset_box",
        kind: "model",
        source: { path: sourcePath, kind: "source", contentHash: hashV1 },
        importedPath: artifactPath,
        recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
        fingerprint: f1,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });

      const reimportService = new AssetReimportService({ database: db });
      const watcher = new SourceAssetWatcher({ debounceMs: 40 });
      watcher.addAsset("asset_box", sourcePath, hashV1);

      const runtimeTarget = new MockRuntimeTarget();

      const coordinator = new AssetHotReloadCoordinator({
        database: db,
        reimportService,
        watcher,
        runtimeTarget,
      });

      await coordinator.start();

      // Touch file: update mtime without changing content
      const now = new Date();
      await utimes(sourcePath, now, now);

      // Wait a moment
      await new Promise((r) => setTimeout(r, 120));

      // No reloads should have occurred
      assert.equal(runtimeTarget.reloadedAssets.length, 0);
      assert.equal(coordinator.getTransactionHistory().length, 0);

      await coordinator.stop();
    },
  );
});
