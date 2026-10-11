import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceStepSchema, runtimeStepStepSchema } from "../src/index.js";

// The Electron player rejects `runtime.step` with steps > 36000 or deltaSeconds > 1
// (apps/player/src/step-params.ts). The probe schema must reject the same values up front,
// otherwise a manifest validates and then fails mid-run with the player's raw TypeError.

test("runtime.step schema accepts the player's inclusive bounds", () => {
  assert.equal(runtimeStepStepSchema.safeParse({ type: "runtime.step" }).success, true);
  assert.equal(
    runtimeStepStepSchema.safeParse({ type: "runtime.step", steps: 36_000, deltaSeconds: 1 }).success,
    true,
  );
  assert.equal(acceptanceStepSchema.safeParse({ type: "runtime.step", steps: 3, deltaSeconds: 0.5 }).success, true);
});

test("runtime.step schema rejects counts and deltas the player would refuse", () => {
  for (const step of [
    { type: "runtime.step", steps: 36_001 },
    { type: "runtime.step", steps: 1e9 },
    { type: "runtime.step", deltaSeconds: 1.0001 },
    { type: "runtime.step", deltaSeconds: 60 },
    { type: "runtime.step", deltaSeconds: Infinity },
    { type: "runtime.step", steps: 0 },
    { type: "runtime.step", steps: 1.5 },
  ]) {
    assert.equal(acceptanceStepSchema.safeParse(step).success, false, JSON.stringify(step));
  }
});
