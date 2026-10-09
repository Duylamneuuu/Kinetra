import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceAssetWatcher, type SourceChangeEvent } from "../src/index.js";

test("an asset removed while its source is being re-read yields no event and keeps no hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-inflight-remove-"));
  const sourcePath = join(dir, "hero.glb");
  await writeFile(sourcePath, "v1");
  const events: SourceChangeEvent[] = [];
  const watcher = new SourceAssetWatcher({ debounceMs: 10, onEvent: (event) => events.push(event) });
  try {
    watcher.addAsset("hero", sourcePath, "stale-hash");
    await writeFile(sourcePath, "v2");

    const pending = watcher.triggerCheck("hero");
    watcher.removeAsset("hero"); // while the file read is in flight
    const result = await pending;

    assert.deepEqual(result, [], "a removed asset was reported as changed");
    assert.deepEqual(events, []);
    assert.equal(watcher.getKnownHash("hero"), undefined, "removed asset's hash was resurrected");
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an asset re-pointed to another path while its old source is being read yields no event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-inflight-repoint-"));
  const oldPath = join(dir, "old.glb");
  const newPath = join(dir, "new.glb");
  await writeFile(oldPath, "old-v1");
  await writeFile(newPath, "new-v1");
  const events: SourceChangeEvent[] = [];
  const watcher = new SourceAssetWatcher({ debounceMs: 10, onEvent: (event) => events.push(event) });
  try {
    watcher.addAsset("hero", oldPath, "old-hash");
    await writeFile(oldPath, "old-v2");

    const pending = watcher.triggerCheck("hero");
    watcher.addAsset("hero", newPath);
    const result = await pending;

    assert.deepEqual(result, [], "a change on the abandoned path was attributed to the re-pointed asset");
    assert.deepEqual(events, []);
    assert.equal(watcher.getKnownHash("hero"), undefined);
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop() while a check is reading the file suppresses the event from that check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-inflight-stop-"));
  const sourcePath = join(dir, "hero.glb");
  await writeFile(sourcePath, "v1");
  const events: SourceChangeEvent[] = [];
  const watcher = new SourceAssetWatcher({ debounceMs: 10, onEvent: (event) => events.push(event) });
  try {
    watcher.addAsset("hero", sourcePath, "stale-hash");
    await watcher.start();
    await writeFile(sourcePath, "v2");

    const pending = watcher.triggerCheck("hero");
    await watcher.stop();
    const result = await pending;

    assert.deepEqual(result, [], "an event escaped after stop()");
    assert.deepEqual(events, []);
    // The change was never delivered, so the next check must still see it.
    const again = await watcher.triggerCheck("hero");
    assert.equal(again.length, 1);
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
