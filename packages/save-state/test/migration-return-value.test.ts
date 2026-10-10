import assert from "node:assert/strict";
import test from "node:test";

import { SaveMigrator, type SaveEnvelope } from "../src/index.js";

function envelope(schemaVersion: number, data: unknown): SaveEnvelope {
  return { schemaVersion, gameVersion: "1.0.0", slotId: "slot-a", savedAt: "2026-01-01T00:00:00.000Z", data };
}

test("a migration that forgets to return its data is an error, not a silently emptied save", () => {
  const migrator = new SaveMigrator(2).register(1, (data) => {
    (data as { coins?: number }).coins = 0; // mutates but returns nothing
    return undefined;
  });
  assert.throws(
    () => migrator.migrate(envelope(1, { sceneId: "arena" })),
    /migration from schema 1 returned undefined/i,
  );
});

test("a migration may legitimately return null or a falsy primitive", () => {
  const migrator = new SaveMigrator(3)
    .register(1, () => 0)
    .register(2, (data) => (data === 0 ? null : "unexpected"));
  const migrated = migrator.migrate(envelope(1, { anything: true }));
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.data, null);
});
