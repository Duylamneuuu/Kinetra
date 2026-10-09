import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetDatabase,
  AssetHotReloadCoordinator,
  AssetReimportService,
  type SourceAssetWatcher,
  type SourceChangeEvent,
} from "../src/index.js";

function stubWatcher() {
  const listeners = new Set<(event: SourceChangeEvent) => void>();
  let failStart = true;
  let starts = 0;
  const watcher = {
    onEvent(listener: (event: SourceChangeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      starts++;
      if (failStart) throw new Error("watch limit reached");
    },
    async stop() {},
  } as unknown as SourceAssetWatcher;
  return {
    watcher,
    listeners,
    starts: () => starts,
    recover: () => {
      failStart = false;
    },
  };
}

test("a coordinator whose watcher failed to start is not left started or subscribed, and can start again", async () => {
  const database = new AssetDatabase();
  const stub = stubWatcher();
  const coordinator = new AssetHotReloadCoordinator({
    database,
    reimportService: new AssetReimportService({ database }),
    watcher: stub.watcher,
  });

  await assert.rejects(coordinator.start(), /watch limit reached/);
  assert.equal(coordinator.isStarted(), false);
  assert.equal(stub.listeners.size, 0, "watcher subscription leaked after failed start");

  stub.recover();
  await coordinator.start();
  assert.equal(coordinator.isStarted(), true);
  assert.equal(stub.starts(), 2, "second start() was swallowed by the stale started flag");
  assert.equal(stub.listeners.size, 1);
  await coordinator.stop();
  assert.equal(stub.listeners.size, 0);
});
