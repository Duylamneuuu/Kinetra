import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceAssetWatcher, type SourceChangeEvent } from "../src/index.js";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("re-adding an asset with a new source path stops watching the old path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-reassign-"));
  const oldPath = join(dir, "old.glb");
  const newPath = join(dir, "new.glb");
  await writeFile(oldPath, "old-v1");
  await writeFile(newPath, "new-v1");

  const events: SourceChangeEvent[] = [];
  const watcher = new SourceAssetWatcher({ debounceMs: 10, onEvent: (event) => events.push(event) });
  try {
    watcher.addAsset("hero", oldPath);
    await watcher.start();
    watcher.addAsset("hero", newPath);

    assert.deepEqual([...watcher.getWatchedAssets()], [["hero", newPath]]);

    // Editing the abandoned file must not be reported as a change of "hero".
    await writeFile(oldPath, "old-v2");
    await settle(300);
    assert.deepEqual(
      events.map((event) => event.sourcePath),
      [],
      "a stale watcher on the old path reported a change for the re-pointed asset",
    );

    // The new path is the one that is watched.
    await writeFile(newPath, "new-v2");
    const checked = await watcher.triggerCheck("hero");
    const all = [...events, ...checked];
    assert.ok(all.length > 0 && all.every((event) => event.sourcePath === newPath));
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("removing one of two assets keeps the other's mapping when ids are re-pointed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-remove-"));
  const pathA = join(dir, "a.glb");
  const pathB = join(dir, "b.glb");
  await writeFile(pathA, "a1");
  await writeFile(pathB, "b1");
  const watcher = new SourceAssetWatcher({ debounceMs: 10 });
  try {
    watcher.addAsset("x", pathA);
    watcher.addAsset("x", pathB);
    watcher.addAsset("y", pathA);
    await watcher.start();
    // "x" no longer owns pathA, so removing "x" must not break "y".
    watcher.removeAsset("x");
    await writeFile(pathA, "a2");
    const events = await watcher.triggerCheck("y");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.assetId, "y");
  } finally {
    await watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
