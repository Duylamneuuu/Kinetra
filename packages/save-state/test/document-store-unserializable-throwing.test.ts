import assert from "node:assert/strict";
import test from "node:test";

import { JsonDocumentStore, MemoryStorage } from "../src/index.js";

// JSON.stringify throws (rather than returning undefined) for BigInt, cycles and throwing toJSON.
// The contract: the call rejects, nothing reaches storage, and the previous document survives.
test("JsonDocumentStore.save rejects BigInt, circular and throwing-toJSON values and keeps the old document", async () => {
  const storage = new MemoryStorage();
  const store = new JsonDocumentStore<unknown>(storage, "saves");
  await store.save("slot-1", { generation: 1 });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const throwing = {
    toJSON(): never {
      throw new Error("toJSON exploded");
    },
  };

  for (const [label, bad] of [
    ["BigInt", { hp: 10n }],
    ["top-level BigInt", 10n],
    ["circular", circular],
    ["throwing toJSON", throwing],
  ] as const) {
    await assert.rejects(() => store.save("slot-1", bad), Error, `${label} must be rejected`);
  }

  assert.deepEqual(await store.load("slot-1"), { generation: 1 });
});

test("JsonDocumentStore.save of a rejected value does not create the slot", async () => {
  const store = new JsonDocumentStore<unknown>(new MemoryStorage(), "saves");
  await assert.rejects(() => store.save("fresh", { hp: 1n }), TypeError);
  assert.equal(await store.load("fresh"), undefined);
});
