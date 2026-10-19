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
  type RuntimeReloadTarget,
} from "../src/index.js";

async function addModel(database: AssetDatabase, dir: string, id: string): Promise<string> {
  const sourcePath = join(dir, `${id}.glb`);
  const artifactPath = join(dir, `imported_${id}.glb`);
  const v1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: `${id}Mesh` });
  await writeFile(sourcePath, v1);
  await writeFile(artifactPath, v1);
  const hash = hashBytes(v1);
  database.upsert({
    id,
    kind: "model",
    source: { path: sourcePath, kind: "source", contentHash: hash },
    importedPath: artifactPath,
    recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
    fingerprint: importFingerprint({ sourceHash: hash, importer: "glb", importerVersion: "1.0", settings: {} }),
    dependencies: [],
    diagnostics: [],
    metadata: {},
  });
  return sourcePath;
}

test("an entity reloaded by two assets in one transaction is listed once in runtimeReloadedEntityIds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-coordinator-unique-"));
  try {
    const database = new AssetDatabase();
    const pathA = await addModel(database, dir, "asset_a");
    const pathB = await addModel(database, dir, "asset_b");

    let rejectNextUpdate = true;
    const reloads: string[] = [];
    const target: RuntimeReloadTarget = {
      async updateAsset() {
        if (rejectNextUpdate) {
          rejectNextUpdate = false;
          throw new Error("resolver is disposed");
        }
      },
      async reloadAsset(assetId) {
        reloads.push(assetId);
        // Both assets are used by the same entity (e.g. a model and its animation clip source).
        return { success: true, affectedEntities: ["ent_shared", `ent_${assetId}`, "ent_shared"] };
      },
      async queryEntities() {
        return [{ entityId: "ent_shared" }, { entityId: "ent_asset_a" }, { entityId: "ent_asset_b" }, { entityId: "ent_idle" }];
      },
    };
    const coordinator = new AssetHotReloadCoordinator({
      database,
      reimportService: new AssetReimportService({ database }),
      watcher: new SourceAssetWatcher({ debounceMs: 10 }),
      runtimeTarget: target,
    });

    // asset_a's publish is rejected -> stale. The next change (asset_b) heals it in the same transaction.
    await writeFile(pathA, await createSyntheticGlb({ size: [4, 2, 1], meshName: "asset_aMesh" }));
    await coordinator.processAssetChange("asset_a");
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_a"]);

    await writeFile(pathB, await createSyntheticGlb({ size: [4, 2, 1], meshName: "asset_bMesh" }));
    const tx = await coordinator.processAssetChange("asset_b");
    assert.ok(tx);
    assert.deepEqual(reloads, ["asset_b", "asset_a"], "both assets were reloaded in this transaction");
    assert.deepEqual(
      [...tx.runtimeReloadedEntityIds].sort(),
      ["ent_asset_a", "ent_asset_b", "ent_shared"],
      "each reloaded entity appears exactly once",
    );
    assert.deepEqual(tx.runtimeUnchangedEntityIds, ["ent_idle"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
