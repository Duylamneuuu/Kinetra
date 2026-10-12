import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SourceAssetWatcher, hashBytes, hashFile, type SourceChangeEvent } from "../src/index.js";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (text: string) => new TextEncoder().encode(text);

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-watch-edges-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an initial hash passed to addAsset is the baseline: same content is silent, a change names the old hash", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "a.glb");
    await writeFile(path, "v1");
    const watcher = new SourceAssetWatcher();
    watcher.addAsset("a", path, hashBytes(bytes("v1")));
    assert.equal(watcher.getKnownHash("a"), hashBytes(bytes("v1")));

    assert.deepEqual(await watcher.triggerCheck("a"), [], "identical bytes must not fire a change");

    await writeFile(path, "v2");
    const [event, ...rest] = await watcher.triggerCheck("a");
    assert.equal(rest.length, 0);
    assert.deepEqual(event, {
      type: "asset.changeDetected",
      assetId: "a",
      sourcePath: path,
      oldContentHash: hashBytes(bytes("v1")),
      newContentHash: hashBytes(bytes("v2")),
    });
    assert.equal(watcher.getKnownHash("a"), hashBytes(bytes("v2")));
    assert.deepEqual(await watcher.triggerCheck(), [], "the new hash is now the baseline");
  });
});

test("setKnownHash replaces the baseline, so rewriting the same bytes reports against it", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "a.glb");
    await writeFile(path, "v1");
    const watcher = new SourceAssetWatcher();
    watcher.addAsset("a", path, hashBytes(bytes("v1")));
    watcher.setKnownHash("a", "not-the-real-hash");
    const events = await watcher.triggerCheck();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.oldContentHash, "not-the-real-hash");
    assert.equal(events[0]?.newContentHash, hashBytes(bytes("v1")));
  });
});

test("an asset with no known hash reports its first read as a change with no old hash", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "a.glb");
    await writeFile(path, "v1");
    const watcher = new SourceAssetWatcher();
    watcher.addAsset("a", path);
    assert.equal(watcher.getKnownHash("a"), undefined);
    const [event] = await watcher.triggerCheck("a");
    assert.equal(event?.oldContentHash, undefined);
    assert.equal(event?.newContentHash, hashBytes(bytes("v1")));
  });
});

test("a source that cannot be read is not an event and keeps the previous hash", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "missing.glb");
    const watcher = new SourceAssetWatcher({ maxRetries: 1, retryDelayMs: 1 });
    watcher.addAsset("gone", path, "h1");
    assert.deepEqual(await watcher.triggerCheck("gone"), []);
    assert.deepEqual(await watcher.triggerCheck(), []);
    assert.equal(watcher.getKnownHash("gone"), "h1");
  });
});

test("start() hashes sources lacking a baseline and tolerates one that does not exist yet", async () => {
  await withDir(async (dir) => {
    const present = join(dir, "present.glb");
    const later = join(dir, "later.glb");
    await writeFile(present, "p1");
    const watcher = new SourceAssetWatcher({ maxRetries: 0, rearmIntervalMs: 5000 });
    try {
      watcher.addAsset("present", present);
      watcher.addAsset("later", later);
      await watcher.start();
      assert.equal(watcher.isWatching(), true);
      assert.equal(watcher.getKnownHash("present"), hashBytes(bytes("p1")));
      assert.equal(watcher.getKnownHash("later"), undefined);
      // start() twice is a no-op.
      await watcher.start();
      assert.equal(watcher.isWatching(), true);
    } finally {
      await watcher.stop();
    }
  });
});

test("removeAsset forgets the asset, its hash and its path; removing an unknown id is harmless", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "a.glb");
    await writeFile(path, "v1");
    const events: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher({ debounceMs: 10, onEvent: (event) => events.push(event) });
    try {
      watcher.removeAsset("never-added");
      watcher.addAsset("a", path, hashBytes(bytes("v1")));
      await watcher.start();
      watcher.removeAsset("a");

      assert.equal(watcher.getWatchedAssets().has("a"), false);
      assert.equal(watcher.getKnownHash("a"), undefined);

      await writeFile(path, "v2");
      assert.deepEqual(await watcher.triggerCheck(), []);
      await settle(150);
      assert.deepEqual(events, [], "a removed asset must not fire change events");
    } finally {
      await watcher.stop();
    }
  });
});

test("a throwing listener is reported and does not stop other listeners or the check", async (t) => {
  await withDir(async (dir) => {
    const path = join(dir, "a.glb");
    await writeFile(path, "v1");
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args);
    });

    const received: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher({
      onEvent: () => {
        throw new Error("listener boom");
      },
    });
    watcher.onEvent((event) => received.push(event));
    watcher.addAsset("a", path, hashBytes(bytes("v0")));

    const events = await watcher.triggerCheck("a");
    assert.equal(events.length, 1, "the check still reports the change to its caller");
    assert.equal(received.length, 1, "later listeners still run");
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]?.[0]), /SourceAssetWatcher event listener/);
    const logError = logged[0]?.[1];
    assert.ok(logError instanceof Error);
    assert.match(logError.message, /listener boom/);
  });
});

test("the function returned by onEvent unsubscribes that listener only", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "a.glb");
    await writeFile(path, "v1");
    const first: SourceChangeEvent[] = [];
    const second: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher();
    const unsubscribeFirst = watcher.onEvent((event) => first.push(event));
    watcher.onEvent((event) => second.push(event));
    watcher.addAsset("a", path, "old");

    await watcher.triggerCheck("a");
    unsubscribeFirst();
    await writeFile(path, "v2");
    await watcher.triggerCheck("a");

    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
  });
});

test("stop() cancels the re-arm poll of a missing source: a file created afterwards is not reported", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "late.glb");
    const events: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher({
      debounceMs: 5,
      maxRetries: 0,
      rearmIntervalMs: 20,
      onEvent: (event) => events.push(event),
    });
    watcher.addAsset("late", path);
    await watcher.start();
    await watcher.stop();
    await writeFile(path, "v1");
    await settle(200);
    assert.deepEqual(events, []);
    assert.equal(watcher.isWatching(), false);
  });
});

test("re-pointing an asset to a missing path drops the old file's baseline", async () => {
  await withDir(async (dir) => {
    const oldPath = join(dir, "old.glb");
    const newPath = join(dir, "new.glb");
    await writeFile(oldPath, "v1");
    const watcher = new SourceAssetWatcher({ maxRetries: 0 });
    watcher.addAsset("a", oldPath, hashBytes(bytes("v1")));
    watcher.addAsset("a", newPath);
    assert.equal(watcher.getKnownHash("a"), undefined);
    assert.equal(watcher.getWatchedAssets().get("a"), newPath);

    await writeFile(newPath, "n1");
    const [event] = await watcher.triggerCheck("a");
    assert.equal(event?.oldContentHash, undefined);
    assert.equal(event?.newContentHash, hashBytes(bytes("n1")));
  });
});

test("hashFile hashes exactly the bytes hashBytes would, and rejects a missing file", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "blob.bin");
    const content = Uint8Array.from([0, 1, 2, 250, 255]);
    await writeFile(path, content);
    assert.equal(await hashFile(path), hashBytes(content));
    await assert.rejects(hashFile(join(dir, "nope.bin")), { code: "ENOENT" });
  });
});
