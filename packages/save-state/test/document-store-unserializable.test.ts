import assert from "node:assert/strict";
import test from "node:test";

import { JsonDocumentStore, MemoryStorage } from "../src/index.js";

test("JsonDocumentStore.save rejects values JSON cannot represent instead of storing `undefined`", async () => {
  const storage = new MemoryStorage();
  const store = new JsonDocumentStore<unknown>(storage, "saves");
  await store.save("slot-1", { ok: true });

  // JSON.stringify(undefined | function | symbol) returns undefined; the old code handed that to
  // storage.set, which MemoryStorage accepted (and the file/IPC backends reject with an opaque error).
  for (const bad of [undefined, () => 1, Symbol("x")]) {
    await assert.rejects(() => store.save("slot-1", bad), TypeError, `expected ${String(bad)} to be rejected`);
  }
  // The earlier document must survive the rejected writes.
  assert.deepEqual(await store.load("slot-1"), { ok: true });
});

test("JsonDocumentStore.save still round-trips ordinary documents, null and arrays", async () => {
  const store = new JsonDocumentStore<unknown>(new MemoryStorage(), "saves");
  for (const value of [null, [], [1, 2], { a: { b: 1 } }, "text", 0]) {
    await store.save("k", value);
    assert.deepEqual(await store.load("k"), value);
  }
});
