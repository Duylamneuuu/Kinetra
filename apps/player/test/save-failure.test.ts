import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSaveFailure } from "../src/save-failure.js";

test("loadSaveFailure carries the phase and the slot id", () => {
  assert.deepEqual(loadSaveFailure("validation", "Invalid save envelope structure", "slot-a"), {
    success: false,
    slotId: "slot-a",
    error: "Invalid save envelope structure",
    phase: "validation",
  });
  assert.deepEqual(loadSaveFailure("migration", "no migration path", "default"), {
    success: false,
    slotId: "default",
    error: "no migration path",
    phase: "migration",
  });
  assert.equal(loadSaveFailure("preparation", "scene mismatch", "s").phase, "preparation");
});

test("loadSaveFailure omits slotId when the slot is not known (runtime not running)", () => {
  const result = loadSaveFailure("validation", "Cannot load save: Runtime is not running");
  assert.equal("slotId" in result, false);
  assert.equal(result.phase, "validation");
  assert.equal(result.success, false);
});

test("loadSaveFailure keeps rollback flags only when given", () => {
  assert.deepEqual(
    loadSaveFailure("commit", "boom", "s", { rolledBack: true }),
    { success: false, slotId: "s", error: "boom", phase: "commit", rolledBack: true },
  );
  assert.deepEqual(
    loadSaveFailure("rollback", "bad", "s", { rolledBack: false, atomicityViolation: true }),
    {
      success: false,
      slotId: "s",
      error: "bad",
      phase: "rollback",
      rolledBack: false,
      atomicityViolation: true,
    },
  );
  const plain = loadSaveFailure("preparation", "x", "s");
  assert.equal("rolledBack" in plain, false);
  assert.equal("atomicityViolation" in plain, false);
});
