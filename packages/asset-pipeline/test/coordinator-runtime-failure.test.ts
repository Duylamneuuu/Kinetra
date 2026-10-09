import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("a runtime target whose updateAsset throws does not abort the transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-coordinator-updatefail-"));
  try {
    const sourcePath = join(dir, "box.glb");
    const artifactPath = join(dir, "imported_box.glb");
    const v1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: "BoxMesh" });
    await writeFile(sourcePath, v1);
    await writeFile(artifactPath, v1);
    const hash = hashBytes(v1);
    const database = new AssetDatabase();
    database.upsert({
      id: "asset_box",
      kind: "model",
      source: { path: sourcePath, kind: "source", contentHash: hash },
      importedPath: artifactPath,
      recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
      fingerprint: importFingerprint({ sourceHash: hash, importer: "glb", importerVersion: "1.0", settings: {} }),
      dependencies: [],
      diagnostics: [],
      metadata: {},
    });

    const reloads: string[] = [];
    const runtimeTarget: RuntimeReloadTarget = {
      async updateAsset() {
        throw new Error("resolver is disposed");
      },
      async reloadAsset(assetId) {
        reloads.push(assetId);
        return { success: true, affectedEntities: [] };
      },
    };
    const events: ReimportEvent[] = [];
    const coordinator = new AssetHotReloadCoordinator({
      database,
      reimportService: new AssetReimportService({ database }),
      watcher: new SourceAssetWatcher({ debounceMs: 10 }),
      runtimeTarget,
      onEvent: (event) => events.push(event),
    });

    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    const tx = await coordinator.processAssetChange("asset_box");

    assert.ok(tx, "the transaction was lost because the runtime target threw");
    assert.deepEqual(tx.rebuiltAssetIds, ["asset_box"]);
    assert.equal(coordinator.getTransactionHistory().length, 1);
    assert.deepEqual(reloads, [], "reloadAsset must not run against a runtime that rejected the new bytes");
    const failed = events.find((event) => event.type === "asset.runtimeReloadFailed");
    assert.ok(failed, "no asset.runtimeReloadFailed event for the failed publish");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
