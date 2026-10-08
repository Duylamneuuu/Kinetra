import assert from "node:assert/strict";
import test from "node:test";

import { AssetDatabase, validateAssetRecord, type AssetRecord } from "../src/index.js";

const HASH = "a".repeat(64);

function record(id: string, dependencies: string[] = [], metadata: AssetRecord["metadata"] = {}): AssetRecord {
  return {
    id,
    kind: "model",
    source: { path: `assets/${id}.glb`, kind: "source", contentHash: HASH },
    importedPath: `.kinetra/imported/${id}.glb`,
    recipe: { importer: "glb", importerVersion: "1", settings: {} },
    fingerprint: HASH,
    dependencies,
    diagnostics: [],
    metadata,
  };
}

test("rejected cyclic upsert leaves the database unchanged (new record)", () => {
  const db = new AssetDatabase();
  db.upsert(record("a", ["b"]));
  assert.throws(() => db.upsert(record("b", ["a"])), /cycle/);
  assert.equal(db.get("b"), undefined, "cyclic record must not be stored");
  assert.deepEqual(db.list().map((r) => r.id), ["a"]);
  // The database must stay usable: an unrelated upsert must not throw.
  assert.doesNotThrow(() => db.upsert(record("c")));
  assert.deepEqual(db.rebuildOrder("a"), ["a"]);
});

test("rejected cyclic upsert restores the previous version of an existing record", () => {
  const db = new AssetDatabase();
  db.upsert(record("a", ["b"]));
  db.upsert(record("b"));
  assert.throws(() => db.upsert(record("b", ["a"])), /cycle/);
  assert.deepEqual(db.get("b")?.dependencies, []);
  assert.deepEqual(db.rebuildOrder("b"), ["b", "a"]);
  assert.doesNotThrow(() => db.upsert(record("c", ["a"])));
});

test("duplicate dependency entries do not drop assets from the rebuild order", () => {
  const db = new AssetDatabase();
  db.upsert(record("tex"));
  db.upsert(record("mat", ["tex", "tex"]));
  db.upsert(record("model", ["mat"]));
  assert.deepEqual(db.dependentsOf("tex"), ["mat", "model"]);
  assert.deepEqual(db.rebuildOrder("tex"), ["tex", "mat", "model"]);
});

test("rebuild order contains every dependent exactly once in a diamond with duplicates", () => {
  const db = new AssetDatabase();
  db.upsert(record("root"));
  db.upsert(record("left", ["root"]));
  db.upsert(record("right", ["root", "root"]));
  db.upsert(record("top", ["left", "right", "left"]));
  const order = db.rebuildOrder("root");
  assert.deepEqual(order, ["root", "left", "right", "top"]);
});

test("validateAssetRecord rejects non-finite or negative polycount and texture size", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    const codes = validateAssetRecord(record("m", [], { polycount: bad })).map((d) => d.code);
    assert.ok(codes.includes("model.polycount.invalid"), `polycount ${bad} must be invalid, got ${codes.join(",")}`);
    const texCodes = validateAssetRecord(record("t", [], { maxTextureDimension: bad })).map((d) => d.code);
    assert.ok(
      texCodes.includes("texture.dimension.invalid"),
      `maxTextureDimension ${bad} must be invalid, got ${texCodes.join(",")}`,
    );
  }
  assert.deepEqual(validateAssetRecord(record("ok", [], { polycount: 0, maxTextureDimension: 1024 })), []);
  const high = validateAssetRecord(record("hi", [], { polycount: 3_000_000 })).map((d) => d.code);
  assert.deepEqual(high, ["model.polycount.high"]);
});
