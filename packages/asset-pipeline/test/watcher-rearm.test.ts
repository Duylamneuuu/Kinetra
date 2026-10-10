import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceAssetWatcher, hashBytes, type SourceChangeEvent } from "../src/index.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await sleep(15);
  }
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watcher-rearm-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("a source moved aside for a backup and rewritten later is still watched (Blender .blend1 style save)", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "hero.blend");
    await writeFile(file, "v1");
    const events: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher({ debounceMs: 20, rearmIntervalMs: 20, onEvent: (e) => events.push(e) });
    watcher.addAsset("hero", file);
    await watcher.start();
    try {
      // The editor renames the original to a backup, and only writes the new file much later than
      // the watcher's own read retries last.
      await rename(file, `${file}1`);
      await sleep(400);
      await writeFile(file, "v2");
      await waitFor(() => events.length >= 1);
      assert.equal(events.length, 1, "the late rewrite is reported");
      assert.equal(events[0]?.newContentHash, hashBytes(text("v2")));

      // ... and the file keeps being watched afterwards.
      await writeFile(file, "v3");
      await waitFor(() => events.length >= 2);
      assert.equal(events.length, 2, "a later edit is reported too");
      assert.equal(events[1]?.newContentHash, hashBytes(text("v3")));
    } finally {
      await watcher.stop();
    }
  });
});

test("a source that does not exist when the watcher starts is picked up once it is created", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "later.blend");
    const events: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher({
      debounceMs: 20,
      rearmIntervalMs: 20,
      maxRetries: 0,
      onEvent: (e) => events.push(e),
    });
    watcher.addAsset("later", file);
    await watcher.start();
    try {
      await sleep(120);
      assert.equal(events.length, 0);
      await writeFile(file, "created");
      await waitFor(() => events.length >= 1);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.assetId, "later");
      assert.equal(events[0]?.newContentHash, hashBytes(text("created")));
    } finally {
      await watcher.stop();
    }
  });
});

test("removing the asset or stopping the watcher cancels the wait for a missing source", async () => {
  await withDir(async (dir) => {
    const removedFile = join(dir, "removed.blend");
    const stoppedFile = join(dir, "stopped.blend");
    const events: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher({
      debounceMs: 20,
      rearmIntervalMs: 20,
      maxRetries: 0,
      onEvent: (e) => events.push(e),
    });
    watcher.addAsset("removed", removedFile);
    watcher.addAsset("stopped", stoppedFile);
    await watcher.start();
    watcher.removeAsset("removed");
    await watcher.stop();
    await writeFile(removedFile, "x");
    await writeFile(stoppedFile, "y");
    await sleep(250);
    assert.equal(events.length, 0, "no events from a removed asset or a stopped watcher");
    assert.equal(watcher.isWatching(), false);
  });
});
