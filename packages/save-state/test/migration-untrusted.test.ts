import assert from "node:assert/strict";
import test from "node:test";

import { createGameplaySaveMigrator, type SaveEnvelope } from "../src/index.js";

function v1Envelope(dataJson: string): SaveEnvelope {
  return JSON.parse(
    `{"schemaVersion":1,"gameVersion":"0.1.0","slotId":"slot","savedAt":"2026-01-01T00:00:00.000Z","data":${dataJson}}`,
  ) as SaveEnvelope;
}

test("v1->v2 migration keeps an entity whose id is \"__proto__\" as plain data", () => {
  const save = v1Envelope(
    '{"sceneId":"s","entities":{"__proto__":{"position":[1,2,3],"state":{"hp":5}},"a":{"rotation":[0,0,0]}}}',
  );
  const migrated = createGameplaySaveMigrator().migrate<{
    sceneId: string;
    entities: Record<string, { position?: number[]; gameplay?: Record<string, unknown> }>;
  }>(save);

  const { entities } = migrated.data;
  assert.equal(Object.getPrototypeOf(entities), Object.prototype, "entities prototype must not be swapped");
  assert.deepEqual(Object.keys(entities).sort(), ["__proto__", "a"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(entities, "__proto__")?.value, {
    position: [1, 2, 3],
    gameplay: { hp: 5 },
  });
  assert.match(JSON.stringify(migrated.data), /"__proto__":\{"position":\[1,2,3\]/);
});

test("v1->v2 migration rejects malformed save data with a descriptive error, not a TypeError", () => {
  const migrator = createGameplaySaveMigrator();
  for (const bad of [
    "null",
    "[]",
    '"text"',
    "42",
    '{"sceneId":"s","entities":[]}',
    '{"sceneId":"s","entities":{"a":null}}',
    '{"sceneId":"s","entities":{"a":7}}',
  ]) {
    assert.throws(
      () => migrator.migrate(v1Envelope(bad)),
      (error: unknown) => error instanceof Error && !(error instanceof TypeError) && /v1/.test(error.message),
      `data ${bad}`,
    );
  }
});
