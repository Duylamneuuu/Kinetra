import assert from "node:assert/strict";
import test from "node:test";

import { preflightEntitySaveEntry } from "../src/save-entry.js";

test("a well-formed entry yields fresh coordinate tuples and the gameplay payload", () => {
  const position = [1, 2, 3];
  const gameplay = { moveCount: 4 };
  const result = preflightEntitySaveEntry("hero", { position, rotation: [0, 0.5, 0], gameplay });
  assert.deepEqual(result, { ok: true, position: [1, 2, 3], rotation: [0, 0.5, 0], gameplay });
  assert.ok(result.ok);
  assert.notEqual(result.position, position, "the tuple is a copy, not the parsed document's array");
});

test("an entry with no fields is valid and restores nothing", () => {
  assert.deepEqual(preflightEntitySaveEntry("hero", {}), { ok: true });
  assert.deepEqual(preflightEntitySaveEntry("hero", { position: null, rotation: undefined }), { ok: true });
});

test("a null, primitive or array entry is a structured rejection, not a TypeError", () => {
  for (const bad of [null, undefined, 7, "x", true, [1, 2, 3]]) {
    const result = preflightEntitySaveEntry("hero", bad);
    assert.equal(result.ok, false, `entry ${JSON.stringify(bad)} must be rejected`);
    assert.ok(!result.ok);
    assert.match(result.error, /Invalid save entry for entity "hero"/);
  }
});

test("bad coordinates are rejected, including falsy values that used to be skipped silently", () => {
  for (const bad of [[1, 2], [1, 2, 3, 4], [NaN, 0, 0], [0, Infinity, 0], [0, 0, "1"], "0,0,0", {}, 0, false, ""]) {
    const position = preflightEntitySaveEntry("hero", { position: bad });
    assert.equal(position.ok, false, `position ${JSON.stringify(bad)} must be rejected`);
    assert.ok(!position.ok);
    assert.match(position.error, /Invalid position coordinates for entity "hero"/);

    const rotation = preflightEntitySaveEntry("hero", { rotation: bad });
    assert.equal(rotation.ok, false, `rotation ${JSON.stringify(bad)} must be rejected`);
    assert.ok(!rotation.ok);
    assert.match(rotation.error, /Invalid rotation coordinates for entity "hero"/);
  }
});

test("a gameplay payload must be a plain object", () => {
  for (const bad of [[], [1], "state", 5, true]) {
    const result = preflightEntitySaveEntry("hero", { gameplay: bad });
    assert.equal(result.ok, false, `gameplay ${JSON.stringify(bad)} must be rejected`);
    assert.ok(!result.ok);
    assert.match(result.error, /Invalid gameplay payload for entity "hero"/);
  }
});

test("an entity id such as __proto__ is reported verbatim", () => {
  const result = preflightEntitySaveEntry("__proto__", null);
  assert.ok(!result.ok);
  assert.match(result.error, /"__proto__"/);
});
