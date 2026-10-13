import assert from "node:assert/strict";
import test from "node:test";

import { calculatePercentiles, countInvalidSamples } from "../src/runtime-helpers.js";

test("calculatePercentiles keeps the finite contract: interpolation, empty and single sample", () => {
  assert.deepEqual(calculatePercentiles([]), { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
  assert.deepEqual(calculatePercentiles([4]), { p50Ms: 4, p95Ms: 4, p99Ms: 4, maxMs: 4 });
  assert.deepEqual(calculatePercentiles([100, 0]), { p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 });
});

test("calculatePercentiles reports NaN for every percentile when any sample is non-finite", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    for (const samples of [[bad], [1, 2, bad, 3], [bad, 5, 1], [10, 10, 10, 10, bad]]) {
      const result = calculatePercentiles(samples);
      for (const [key, value] of Object.entries(result)) {
        assert.ok(Number.isNaN(value), `${key} = ${value} for ${JSON.stringify(samples)}`);
      }
    }
  }
});

test("countInvalidSamples counts only samples that are not finite numbers", () => {
  assert.equal(countInvalidSamples([]), 0);
  assert.equal(countInvalidSamples([0, 1, -2.5]), 0);
  assert.equal(countInvalidSamples([Number.NaN, 1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]), 3);
  assert.equal(countInvalidSamples(["3" as unknown as number, undefined as unknown as number, 2]), 2);
});
