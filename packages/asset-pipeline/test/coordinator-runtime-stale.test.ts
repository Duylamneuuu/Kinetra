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

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-coordinator-stale-"));
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
  return { dir, sourcePath, database };
}

function makeTarget(failUpdates: { count: number }) {
  const updates: Array<{ assetId: string; sourceHash: string | undefined }> = [];
  const reloads: string[] = [];
  const target: RuntimeReloadTarget = {
    async updateAsset(assetId, _data, options) {
      if (failUpdates.count > 0) {
        failUpdates.count -= 1;
        throw new Error("resolver is disposed");
      }
      updates.push({ assetId, sourceHash: options?.sourceHash });
    },
    async reloadAsset(assetId) {
      reloads.push(assetId);
      return { success: true, affectedEntities: ["ent_box"] };
    },
  };
  return { target, updates, reloads };
}

test("an asset whose runtime publish failed is reported stale and healed by retryRuntimePublish", async () => {
  const { dir, sourcePath, database } = await setup();
  try {
    const { target, updates, reloads } = makeTarget({ count: 1 });
    const coordinator = new AssetHotReloadCoordinator({
      database,
      reimportService: new AssetReimportService({ database }),
      watcher: new SourceAssetWatcher({ debounceMs: 10 }),
      runtimeTarget: target,
    });

    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
    assert.equal(await coordinator.retryRuntimePublish(), null, "nothing is stale yet");

    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    const tx = await coordinator.processAssetChange("asset_box");
    assert.ok(tx);
    assert.equal(updates.length, 0, "the first publish was rejected");
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box"]);

    const retry = await coordinator.retryRuntimePublish();
    assert.ok(retry, "retryRuntimePublish must publish the stale asset");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.assetId, "asset_box");
    assert.equal(updates[0]?.sourceHash, database.get("asset_box")?.source.contentHash);
    assert.deepEqual(reloads, ["asset_box"]);
    assert.deepEqual(retry.runtimeReloadedEntityIds, ["ent_box"]);
    assert.deepEqual(retry.rebuiltAssetIds, ["asset_box"]);
    assert.equal(retry.error, undefined);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
    assert.equal(coordinator.getTransactionHistory().length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a repeated change event for a stale asset retries the publish even though the source hash already matches", async () => {
  const { dir, sourcePath, database } = await setup();
  try {
    const { target, updates, reloads } = makeTarget({ count: 1 });
    const events: ReimportEvent[] = [];
    const coordinator = new AssetHotReloadCoordinator({
      database,
      reimportService: new AssetReimportService({ database }),
      watcher: new SourceAssetWatcher({ debounceMs: 10 }),
      runtimeTarget: target,
      onEvent: (event) => events.push(event),
    });

    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    await coordinator.processAssetChange("asset_box");
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box"]);

    // Same bytes on disk: the reimport service reports a no-op, which used to end the story with the runtime
    // still on the old asset.
    const second = await coordinator.processAssetChange("asset_box");
    assert.ok(second, "a stale asset must be republished on the next change check");
    assert.equal(updates.length, 1);
    assert.deepEqual(reloads, ["asset_box"]);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
    assert.ok(events.some((event) => event.type === "asset.runtimeReloadSucceeded"));

    // Once healed, a further identical check is a plain no-op again.
    assert.equal(await coordinator.processAssetChange("asset_box"), null);
    assert.equal(updates.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retryRuntimePublish keeps the asset stale and reports an error while the runtime keeps rejecting it", async () => {
  const { dir, sourcePath, database } = await setup();
  try {
    const { target, updates } = makeTarget({ count: 2 });
    const coordinator = new AssetHotReloadCoordinator({
      database,
      reimportService: new AssetReimportService({ database }),
      watcher: new SourceAssetWatcher({ debounceMs: 10 }),
      runtimeTarget: target,
    });

    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    await coordinator.processAssetChange("asset_box");
    const failedRetry = await coordinator.retryRuntimePublish();
    assert.ok(failedRetry);
    assert.deepEqual(failedRetry.rebuiltAssetIds, []);
    assert.match(failedRetry.error ?? "", /asset_box/);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box"]);

    const healed = await coordinator.retryRuntimePublish();
    assert.ok(healed);
    assert.equal(healed.error, undefined);
    assert.equal(updates.length, 1);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale asset whose imported artifact can no longer be read emits asset.runtimeReloadFailed (Refs #498)", async () => {
  const { dir, sourcePath, database } = await setup();
  try {
    const { target } = makeTarget({ count: 1 });
    const events: ReimportEvent[] = [];
    const coordinator = new AssetHotReloadCoordinator({
      database,
      reimportService: new AssetReimportService({ database }),
      watcher: new SourceAssetWatcher({ debounceMs: 10 }),
      runtimeTarget: target,
      onEvent: (event) => events.push(event),
    });
    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    await coordinator.processAssetChange("asset_box");
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box"]);
    events.length = 0;

    await rm(database.get("asset_box")!.importedPath, { force: true });
    await coordinator.retryRuntimePublish();

    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box"], "still stale");
    const failed = events.filter((event) => event.type === "asset.runtimeReloadFailed");
    assert.equal(failed.length, 1, "the unreadable artifact must be reported, not swallowed");
    assert.equal(failed[0]?.assetId, "asset_box");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setupTwo() {
  const base = await setup();
  const sourceB = join(base.dir, "ball.glb");
  const artifactB = join(base.dir, "imported_ball.glb");
  const v1 = await createSyntheticGlb({ size: [2, 2, 2], meshName: "BallMesh" });
  await writeFile(sourceB, v1);
  await writeFile(artifactB, v1);
  const hash = hashBytes(v1);
  base.database.upsert({
    id: "asset_ball",
    kind: "model",
    source: { path: sourceB, kind: "source", contentHash: hash },
    importedPath: artifactB,
    recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
    fingerprint: importFingerprint({ sourceHash: hash, importer: "glb", importerVersion: "1.0", settings: {} }),
    dependencies: [],
    diagnostics: [],
    metadata: {},
  });
  return { ...base, sourceB };
}

function makeCoordinator(database: AssetDatabase, target: RuntimeReloadTarget) {
  return new AssetHotReloadCoordinator({
    database,
    reimportService: new AssetReimportService({ database }),
    watcher: new SourceAssetWatcher({ debounceMs: 10 }),
    runtimeTarget: target,
  });
}

test("a stale asset healed by another asset's transaction is listed in that transaction (Refs #498)", async () => {
  const { dir, sourcePath, sourceB, database } = await setupTwo();
  try {
    const { target, reloads } = makeTarget({ count: 1 });
    const coordinator = makeCoordinator(database, target);
    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    await coordinator.processAssetChange("asset_box");
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box"]);

    await writeFile(sourceB, await createSyntheticGlb({ size: [3, 3, 3], meshName: "BallMesh" }));
    const tx = await coordinator.processAssetChange("asset_ball");
    assert.ok(tx);
    assert.deepEqual(reloads.sort(), ["asset_ball", "asset_box"]);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
    // The healed asset's entities are in runtimeReloadedEntityIds, so the asset must be in the tx too.
    assert.ok(tx.rebuiltAssetIds.includes("asset_box"), `rebuiltAssetIds=${JSON.stringify(tx.rebuiltAssetIds)}`);
    assert.ok(tx.rebuildOrder.includes("asset_box"), `rebuildOrder=${JSON.stringify(tx.rebuildOrder)}`);
    assert.equal(tx.rootAssetId, "asset_ball");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("waitForAssetReload resolves for a stale asset that is not the first one when retryRuntimePublish heals it (Refs #498)", async () => {
  const { dir, sourcePath, sourceB, database } = await setupTwo();
  try {
    // box fails once; ball's transaction retries box as a ride-along and both fail again.
    const { target } = makeTarget({ count: 3 });
    const coordinator = makeCoordinator(database, target);
    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    await writeFile(sourceB, await createSyntheticGlb({ size: [3, 3, 3], meshName: "BallMesh" }));
    await coordinator.processAssetChange("asset_box");
    await coordinator.processAssetChange("asset_ball");
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box", "asset_ball"]);

    const waiting = coordinator.waitForAssetReload("asset_ball", 2000);
    const retry = await coordinator.retryRuntimePublish();
    const tx = await waiting;
    assert.equal(tx, retry);
    assert.deepEqual(tx.rebuiltAssetIds, ["asset_box", "asset_ball"]);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale asset removed from the database is dropped by retryRuntimePublish without a publish (Refs #498)", async () => {
  const { dir, sourcePath, database } = await setup();
  try {
    const { target, updates } = makeTarget({ count: 1 });
    const coordinator = makeCoordinator(database, target);
    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    await coordinator.processAssetChange("asset_box");
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), ["asset_box"]);

    // AssetDatabase has no delete API yet; model a record that disappeared while the asset was stale.
    const originalGet = database.get.bind(database);
    database.get = (id: string) => (id === "asset_box" ? undefined : originalGet(id));
    const retry = await coordinator.retryRuntimePublish();
    assert.ok(retry);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
    assert.equal(updates.length, 0);
    assert.deepEqual(retry.rebuiltAssetIds, [], "a removed asset was not published");
    assert.equal(retry.error, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retryRuntimePublish waits for an in-flight processAssetChange instead of overlapping it (Refs #498)", async () => {
  const { dir, sourcePath, database } = await setup();
  try {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const target: RuntimeReloadTarget = {
      async updateAsset(assetId) {
        calls += 1;
        order.push(`update-start:${calls}`);
        if (calls === 1) {
          await gate;
          throw new Error("resolver is disposed");
        }
        order.push(`update-ok:${assetId}`);
      },
      async reloadAsset() {
        return { success: true, affectedEntities: ["ent_box"] };
      },
    };
    const coordinator = makeCoordinator(database, target);
    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "BoxMesh" }));
    const first = coordinator.processAssetChange("asset_box");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = coordinator.retryRuntimePublish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, ["update-start:1"], "the retry must not publish while the transaction is in flight");
    release();
    await first;
    const tx = await retry;
    assert.ok(tx);
    assert.deepEqual(order, ["update-start:1", "update-start:2", "update-ok:asset_box"]);
    assert.deepEqual(coordinator.getRuntimeStaleAssetIds(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
