import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceAssetWatcher, type SourceChangeEvent } from "../src/index.js";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("stop() while start() is still hashing files leaves no live fs watchers behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-lifecycle-"));
  const paths = ["a.glb", "b.glb", "c.glb"].map((name) => join(dir, name));
  for (const path of paths) await writeFile(path, "v1");

  const events: SourceChangeEvent[] = [];
  const watcher = new SourceAssetWatcher({ debounceMs: 10, onEvent: (event) => events.push(event) });
  try {
    paths.forEach((path, index) => watcher.addAsset(`asset${index}`, path));

    const starting = watcher.start();
    await watcher.stop(); // stop requested before start() has finished its async setup
    await starting;

    assert.equal(watcher.isWatching(), false);

    // A stopped watcher must be deaf: editing sources must not produce change events.
    for (const path of paths) await writeFile(path, "v2");
    await settle(300);
    assert.deepEqual(
      events.map((event) => event.assetId),
      [],
      "a watcher created by start() after stop() kept reporting changes",
    );
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stopped watcher can be started again and reports changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-restart-"));
  const path = join(dir, "a.glb");
  await writeFile(path, "v1");
  const events: SourceChangeEvent[] = [];
  const watcher = new SourceAssetWatcher({ debounceMs: 10, onEvent: (event) => events.push(event) });
  try {
    watcher.addAsset("a", path);
    await watcher.start();
    await watcher.stop();
    await watcher.start();
    await writeFile(path, "v2");
    const polled = await watcher.triggerCheck("a");
    await settle(150);
    assert.ok(events.length + polled.length >= 1);
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
