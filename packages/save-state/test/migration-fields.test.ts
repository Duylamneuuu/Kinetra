import assert from "node:assert/strict";
import test from "node:test";

import { createGameplaySaveMigrator, type SaveEnvelope } from "../src/index.js";

function v1Envelope(dataJson: string): SaveEnvelope {
  return JSON.parse(
    `{"schemaVersion":1,"gameVersion":"0.1.0","slotId":"slot","savedAt":"2026-01-01T00:00:00.000Z","data":${dataJson}}`,
  ) as SaveEnvelope;
}

test("v1->v2 migration rejects a missing, empty or non-string sceneId and names the field", () => {
  const migrator = createGameplaySaveMigrator();
  for (const bad of ['{"entities":{}}', '{"sceneId":5,"entities":{}}', '{"sceneId":"","entities":{}}', '{"sceneId":null}']) {
    assert.throws(
      () => migrator.migrate(v1Envelope(bad)),
      (error: unknown) => error instanceof Error && /v1/.test(error.message) && /sceneId/.test(error.message),
      `data ${bad}`,
    );
  }
});

test("v1->v2 migration rejects a malformed position/rotation/state and names the field", () => {
  const migrator = createGameplaySaveMigrator();
  const cases: Array<[string, RegExp]> = [
    ['{"sceneId":"s","entities":{"a":{"position":"x"}}}', /position/],
    ['{"sceneId":"s","entities":{"a":{"position":[1,2]}}}', /position/],
    ['{"sceneId":"s","entities":{"a":{"position":[1,2,null]}}}', /position/],
    ['{"sceneId":"s","entities":{"a":{"rotation":{"x":1}}}}', /rotation/],
    ['{"sceneId":"s","entities":{"a":{"rotation":[0,0,"1"]}}}', /rotation/],
    ['{"sceneId":"s","entities":{"a":{"state":null}}}', /state/],
    ['{"sceneId":"s","entities":{"a":{"state":[1]}}}', /state/],
    ['{"sceneId":"s","entities":{"a":{"state":7}}}', /state/],
  ];
  for (const [bad, field] of cases) {
    assert.throws(
      () => migrator.migrate(v1Envelope(bad)),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof TypeError) &&
        /v1/.test(error.message) &&
        field.test(error.message) &&
        /"a"/.test(error.message),
      `data ${bad}`,
    );
  }
});

test("v1->v2 migration still accepts a well-formed save, including absent optional fields", () => {
  const migrated = createGameplaySaveMigrator().migrate<{ sceneId: string; entities: Record<string, unknown> }>(
    v1Envelope('{"sceneId":"arena","entities":{"a":{"position":[1,2,3],"rotation":[0,0.5,0],"state":{"hp":3}},"b":{}}}'),
  );
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.data.sceneId, "arena");
  assert.deepEqual(migrated.data.entities, {
    a: { position: [1, 2, 3], rotation: [0, 0.5, 0], gameplay: { hp: 3 } },
    b: {},
  });
  const noEntities = createGameplaySaveMigrator().migrate<{ entities: unknown }>(v1Envelope('{"sceneId":"arena"}'));
  assert.deepEqual(noEntities.data.entities, {});
});
