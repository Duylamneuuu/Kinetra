import assert from "node:assert/strict";
import test from "node:test";

import { AssetDatabase, type AssetRecord } from "../src/index.js";

const HASH = "a".repeat(64);

function record(id: string, dependencies: string[] = []): AssetRecord {
  return {
    id,
    kind: "model",
    source: { path: `assets/${id}.glb`, kind: "source", contentHash: HASH },
    importedPath: `.kinetra/imported/${id}.glb`,
    recipe: { importer: "glb", importerVersion: "1", settings: {} },
    fingerprint: HASH,
    dependencies,
    diagnostics: [],
    metadata: {},
  };
}

// String.prototype.localeCompare follows the host ICU/locale ("a" < "B" in en, "B" < "a" by code unit),
// so a serialized asset database (and the rebuild order) would differ between machines.
// Ordering must be by UTF-16 code unit, like the other deterministic orderings in the engine.

test("list() and serialize() order assets by code unit, independent of host locale", () => {
  const db = new AssetDatabase();
  for (const id of ["b", "B", "_x", "a", "A", "Z", "é", "e"]) db.upsert(record(id));
  const expected = ["A", "B", "Z", "_x", "a", "b", "e", "é"];
  assert.deepEqual(db.list().map((r) => r.id), expected);
  assert.deepEqual(db.serialize().assets.map((r) => r.id), expected);
});

test("rebuild order breaks ties by code unit, independent of host locale", () => {
  const db = new AssetDatabase();
  db.upsert(record("root"));
  for (const id of ["b", "B", "a", "A", "_x"]) db.upsert(record(id, ["root"]));
  assert.deepEqual(db.rebuildOrder("root"), ["root", "A", "B", "_x", "a", "b"]);
  assert.deepEqual(db.dependentsOf("root"), ["A", "B", "_x", "a", "b"]);
});

test("rebuild order still respects dependencies when ids tie-break by code unit", () => {
  const db = new AssetDatabase();
  db.upsert(record("root"));
  db.upsert(record("b", ["root"]));
  db.upsert(record("a", ["b"]));
  db.upsert(record("B", ["root"]));
  assert.deepEqual(db.rebuildOrder("root"), ["root", "B", "b", "a"]);
});
