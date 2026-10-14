import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetDatabase,
  AssetHotReloadCoordinator,
  type AssetReimportService,
  type SourceAssetWatcher,
  type SourceChangeEvent,
} from "../src/index.js";

function makeDatabase(): AssetDatabase {
  const database = new AssetDatabase();
  for (const id of ["asset_a", "asset_b"]) {
    database.upsert({
      id,
      kind: "model",
      source: { path: `/tmp/${id}.glb`, kind: "source", contentHash: "h" },
      importedPath: `/tmp/imported_${id}.glb`,
      recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
      fingerprint: "f",
      dependencies: [],
      diagnostics: [],
      metadata: {},
    });
  }
  return database;
}

function makeHarness() {
  const watcherListeners = new Set<(event: SourceChangeEvent) => void>();
  const watcher = {
    onEvent(listener: (event: SourceChangeEvent) => void) {
      watcherListeners.add(listener);
      return () => watcherListeners.delete(listener);
    },
    async start() {},
    async stop() {},
  } as unknown as SourceAssetWatcher;

  const reimported: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reimportService = {
    onEvent: () => () => {},
    async reimportWithDependents(assetId: string) {
      reimported.push(assetId);
      await gate;
      return { status: "noop" };
    },
  } as unknown as AssetReimportService;
  return { watcher, watcherListeners, reimportService, reimported, release };
}

test("stop() cancels a change that was still queued behind the in-flight transaction", async () => {
  const database = makeDatabase();
  const h = makeHarness();
  const coordinator = new AssetHotReloadCoordinator({
    database,
    reimportService: h.reimportService,
    watcher: h.watcher,
  });
  await coordinator.start();

  const first = coordinator.processAssetChange("asset_a");
  // The second change arrives while the first reimport is still running: it queues behind it.
  const second = coordinator.processAssetChange("asset_b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.reimported, ["asset_a"]);

  const stopping = coordinator.stop();
  h.release();
  await stopping;
  assert.equal(await first, null);
  assert.equal(await second, null);

  // Let any leaked continuation run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.reimported, ["asset_a"], "a transaction ran after stop() returned");
  assert.equal(coordinator.isStarted(), false);
});

test("a stopped coordinator can be started again and processes changes normally", async () => {
  const database = makeDatabase();
  const h = makeHarness();
  h.release();
  const coordinator = new AssetHotReloadCoordinator({
    database,
    reimportService: h.reimportService,
    watcher: h.watcher,
  });
  await coordinator.start();
  await coordinator.stop();
  await coordinator.start();
  await coordinator.processAssetChange("asset_a");
  assert.deepEqual(h.reimported, ["asset_a"]);
  await coordinator.stop();
});
