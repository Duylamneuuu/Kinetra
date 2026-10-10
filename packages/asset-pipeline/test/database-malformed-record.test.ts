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

/** A plain Error carrying a message about `field`, never a TypeError from poking at undefined. */
function rejectsWith(action: () => unknown, field: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof TypeError), `expected a deliberate error, got TypeError: ${error.message}`);
    assert.match(error.message, field);
    return true;
  });
}

test("upsert rejects dependencies that are not an array of strings and stores nothing", () => {
  const db = new AssetDatabase();
  db.upsert(record("a"));
  for (const bad of [undefined, null, "a", 7, { length: 0 }, [1], [null], ["a", {}]]) {
    const malformed = { ...record("m"), dependencies: bad } as unknown as AssetRecord;
    rejectsWith(() => db.upsert(malformed), /dependencies/);
  }
  assert.deepEqual(db.list().map((r) => r.id), ["a"]);
  assert.deepEqual(db.rebuildOrder("a"), ["a"]);
});

test("upsert rejects an id that is not a non-empty string", () => {
  const db = new AssetDatabase();
  for (const bad of [undefined, null, 42, "", {}, ["x"]]) {
    const malformed = { ...record("m"), id: bad } as unknown as AssetRecord;
    rejectsWith(() => db.upsert(malformed), /id/i);
  }
  assert.deepEqual(db.list(), []);
});

test("upsert rejects a record that is not an object", () => {
  const db = new AssetDatabase();
  for (const bad of [undefined, null, "a", 3]) {
    rejectsWith(() => db.upsert(bad as unknown as AssetRecord), /record/);
  }
});

test("the constructor reports a document without an assets array instead of a TypeError", () => {
  for (const assets of [undefined, null, {}, "a"]) {
    rejectsWith(() => new AssetDatabase({ schemaVersion: 1, assets } as never), /assets/);
  }
  rejectsWith(() => new AssetDatabase(null as never), /schema/);
});
