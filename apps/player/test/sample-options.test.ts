import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SAMPLE_DELTA_SECONDS,
  MAX_SAMPLE_FRAMES,
  resolvePerformanceSampleOptions,
} from "../src/sample-options.js";

// Luồng C: performance.sample accepted any number. warmupFrames Infinity / 1e9 froze the renderer
// in a synchronous loop and fixedDeltaSeconds NaN poisoned scripts, physics and animation.

test("defaults apply when nothing (or null) is given", () => {
  const expected = { warmupFrames: 10, sampleFrames: 60, fixedDeltaSeconds: 1 / 60 };
  assert.deepEqual(resolvePerformanceSampleOptions(), expected);
  assert.deepEqual(resolvePerformanceSampleOptions({}), expected);
  assert.deepEqual(
    resolvePerformanceSampleOptions({ warmupFrames: null, sampleFrames: null, fixedDeltaSeconds: null }),
    expected,
  );
});

test("valid values pass through, including the boundaries", () => {
  assert.deepEqual(
    resolvePerformanceSampleOptions({ warmupFrames: 0, sampleFrames: 1, fixedDeltaSeconds: MAX_SAMPLE_DELTA_SECONDS }),
    { warmupFrames: 0, sampleFrames: 1, fixedDeltaSeconds: 1 },
  );
  assert.deepEqual(
    resolvePerformanceSampleOptions({ warmupFrames: MAX_SAMPLE_FRAMES, sampleFrames: MAX_SAMPLE_FRAMES, fixedDeltaSeconds: 0.001 }),
    { warmupFrames: MAX_SAMPLE_FRAMES, sampleFrames: MAX_SAMPLE_FRAMES, fixedDeltaSeconds: 0.001 },
  );
});

test("warmupFrames rejects Infinity, NaN, fractions, negatives, huge counts and non-numbers", () => {
  for (const bad of [Infinity, -Infinity, NaN, 1.5, -1, MAX_SAMPLE_FRAMES + 1, 1e9, "10", true, {}]) {
    assert.throws(() => resolvePerformanceSampleOptions({ warmupFrames: bad }), TypeError, `warmupFrames ${String(bad)}`);
  }
});

test("sampleFrames needs at least one measured frame and the same bounds", () => {
  for (const bad of [0, Infinity, NaN, 2.5, -3, MAX_SAMPLE_FRAMES + 1, "60"]) {
    assert.throws(() => resolvePerformanceSampleOptions({ sampleFrames: bad }), /sampleFrames/, `sampleFrames ${String(bad)}`);
  }
});

test("fixedDeltaSeconds must be finite and in (0, 1]", () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -0.01, 1.0001, 60, "0.016"]) {
    assert.throws(() => resolvePerformanceSampleOptions({ fixedDeltaSeconds: bad }), /fixedDeltaSeconds/, `delta ${String(bad)}`);
  }
});
