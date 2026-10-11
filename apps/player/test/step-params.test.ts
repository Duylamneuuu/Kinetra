import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STEP_DELTA_SECONDS,
  MAX_STEPS_PER_CALL,
  parseRuntimeStepParams,
} from "../src/step-params.js";

test("runtime.step params default to one 1/60 s step", () => {
  assert.deepEqual(parseRuntimeStepParams(), { steps: 1, deltaSeconds: 1 / 60 });
  assert.deepEqual(parseRuntimeStepParams({ steps: null, deltaSeconds: null }), { steps: 1, deltaSeconds: 1 / 60 });
});

test("runtime.step params accept the inclusive bounds", () => {
  assert.deepEqual(parseRuntimeStepParams({ steps: 0 }), { steps: 0, deltaSeconds: 1 / 60 });
  assert.deepEqual(
    parseRuntimeStepParams({ steps: MAX_STEPS_PER_CALL, deltaSeconds: MAX_STEP_DELTA_SECONDS }),
    { steps: MAX_STEPS_PER_CALL, deltaSeconds: MAX_STEP_DELTA_SECONDS },
  );
  assert.equal(parseRuntimeStepParams({ deltaSeconds: Number.MIN_VALUE }).deltaSeconds, Number.MIN_VALUE);
});

test("runtime.step params reject bad step counts", () => {
  for (const steps of [-1, 1.5, Number.NaN, Infinity, -Infinity, MAX_STEPS_PER_CALL + 1, "3", true, {}]) {
    assert.throws(() => parseRuntimeStepParams({ steps }), /steps must be an integer from 0 to 36000/, String(steps));
  }
});

test("runtime.step params reject bad deltas", () => {
  for (const deltaSeconds of [0, -0, -1 / 60, Number.NaN, Infinity, MAX_STEP_DELTA_SECONDS + 1e-9, "0.016", false]) {
    assert.throws(
      () => parseRuntimeStepParams({ deltaSeconds }),
      /deltaSeconds must be a finite number in \(0, 1\]/,
      String(deltaSeconds),
    );
  }
});
