import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSaveFailure, loadSaveSupersededMessage } from "../src/save-failure.js";

test("a load overtaken by stop()/start() reports a structured preparation failure that applied nothing", () => {
  const message = loadSaveSupersededMessage();
  assert.match(message, /stopped or restarted/);
  assert.match(message, /nothing was applied/);

  const failure = loadSaveFailure("preparation", message, "slot-1");
  assert.equal(failure.success, false);
  assert.equal(failure.phase, "preparation");
  assert.equal(failure.slotId, "slot-1");
  assert.equal(failure.error, message);
  // Nothing was committed, so there is nothing to roll back and no atomicity violation to report.
  assert.equal(failure.rolledBack, undefined);
  assert.equal(failure.atomicityViolation, undefined);
});
