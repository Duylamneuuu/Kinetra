import assert from "node:assert/strict";
import test from "node:test";

import { preflightEntitySaveEntry } from "../src/save-entry.js";
import { captureEntityStates, buildAssetQueryById } from "../src/keyed-snapshots.js";

const POISONED_IDS = ["__proto__", "constructor", "toString", "hasOwnProperty"];

function object(x: number, y: number, z: number) {
  return { position: { x, y, z }, rotation: { x: 0, y: z, z: 0 } };
}

test("captureEntityStates keeps hostile entity ids as own keys through JSON", () => {
  const states = captureEntityStates(
    [
      ["__proto__", object(1, 2, 3)],
      ["constructor", object(4, 5, 6)],
      ["hero", object(7, 8, 9)],
    ],
    (entityId) => (entityId === "__proto__" ? { moveCount: 3 } : undefined),
  );

  assert.deepEqual(Object.keys(states).sort(), ["__proto__", "constructor", "hero"]);
  assert.equal(Object.getPrototypeOf(states), null);
  assert.deepEqual(states["__proto__"], {
    position: [1, 2, 3],
    rotation: [0, 3, 0],
    gameplay: { moveCount: 3 },
  });

  const roundTripped = JSON.parse(JSON.stringify(states)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(roundTripped).sort(), ["__proto__", "constructor", "hero"]);
  assert.ok(Object.hasOwn(roundTripped, "__proto__"), "__proto__ must be an own key after JSON.parse");
});

test("a saved __proto__ entity passes the same preflight loadSave applies to every entry", () => {
  const states = captureEntityStates([["__proto__", object(1, 2, 3)]], () => ({ moveCount: 1 }));
  const parsed = JSON.parse(JSON.stringify(states)) as Record<string, unknown>;

  const restored = Object.entries(parsed).map(([entityId, entry]) =>
    preflightEntitySaveEntry(entityId, entry),
  );
  assert.deepEqual(restored, [
    { ok: true, position: [1, 2, 3], rotation: [0, 3, 0], gameplay: { moveCount: 1 } },
  ]);
});

test("captureEntityStates omits gameplay when the script has none and copies it when present", () => {
  const live = { nested: { n: 1 } };
  const states = captureEntityStates(
    [
      ["a", object(0, 0, 0)],
      ["b", object(0, 0, 0)],
    ],
    (entityId) => (entityId === "b" ? live : undefined),
  );
  assert.equal("gameplay" in states["a"]!, false);
  assert.deepEqual(states["b"]!.gameplay, live);
  assert.notEqual(states["b"]!.gameplay, live, "the save must not alias live script state");
  assert.notEqual((states["b"]!.gameplay as typeof live).nested, live.nested);
});

test("captureEntityStates of nothing is an empty prototype-less record", () => {
  const states = captureEntityStates([], () => undefined);
  assert.deepEqual(Object.keys(states), []);
  assert.equal(Object.getPrototypeOf(states), null);
});

test("buildAssetQueryById keeps hostile asset ids as own keys and reports per-asset state", () => {
  const byId = buildAssetQueryById(POISONED_IDS, {
    sourceHashes: new Map([["__proto__", "sha-1"]]),
    fingerprints: new Map([["constructor", "fp-1"]]),
    statuses: new Map([["toString", "failed"]]),
    revisions: new Map([["hasOwnProperty", 7]]),
  });

  assert.deepEqual(Object.keys(byId).sort(), [...POISONED_IDS].sort());
  assert.equal(Object.getPrototypeOf(byId), null);
  assert.deepEqual(byId["__proto__"], { assetId: "__proto__", sourceHash: "sha-1", importStatus: "imported" });
  assert.deepEqual(byId["constructor"], { assetId: "constructor", fingerprint: "fp-1", importStatus: "imported" });
  assert.deepEqual(byId["toString"], { assetId: "toString", importStatus: "failed" });
  assert.deepEqual(byId["hasOwnProperty"], { assetId: "hasOwnProperty", importStatus: "imported", revision: 7 });

  const roundTripped = JSON.parse(JSON.stringify(byId)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(roundTripped).sort(), [...POISONED_IDS].sort());
});
