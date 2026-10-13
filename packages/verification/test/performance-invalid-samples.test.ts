import assert from "node:assert/strict";
import test from "node:test";

import {
  calculatePercentiles,
  evaluatePerformanceBudget,
  type RuntimePerformanceEvidence,
} from "../src/performance.js";

const timing = (p50Ms: number, p95Ms: number, p99Ms: number, maxMs: number) => ({ p50Ms, p95Ms, p99Ms, maxMs });

const healthy: RuntimePerformanceEvidence = {
  sampleCount: 5,
  warmupSamples: 1,
  executionMode: "stepped",
  frame: timing(10, 12, 13, 14),
  simulation: timing(2, 3, 4, 5),
  render: timing(7, 8, 9, 10),
  renderer: { drawCalls: 3, triangles: 100, points: 0, lines: 0, geometries: 1, textures: 1 },
  scene: {
    objectCount: 1,
    visibleObjectCount: 1,
    modelInstanceCount: 0,
    skinnedMeshCount: 0,
    activeAnimationMixerCount: 0,
  },
};

test("a violation on a NaN metric says why when the evidence reports invalid samples", () => {
  const poisoned: RuntimePerformanceEvidence = {
    ...healthy,
    frame: calculatePercentiles([16, 16, Number.NaN, 16, Number.POSITIVE_INFINITY]),
    invalidSamples: { frame: 2 },
  };
  const result = evaluatePerformanceBudget(poisoned, { "frame.p95Ms": 33 }, { platform: "linux" });
  assert.equal(result.passed, false);
  assert.equal(result.violations.length, 1);
  const violation = result.violations[0]!;
  assert.equal(violation.metric, "frame.p95Ms");
  assert.ok(Number.isNaN(violation.actual));
  assert.match(violation.reason ?? "", /frame had 2 non-finite timing samples, so frame\.p95Ms is NaN/);
});

test("the reason is singular for one sample and ignores series that were fine", () => {
  const poisoned: RuntimePerformanceEvidence = {
    ...healthy,
    render: calculatePercentiles([1, Number.NaN]),
    invalidSamples: { render: 1, frame: 0 },
  };
  const result = evaluatePerformanceBudget(
    poisoned,
    { "render.maxMs": 20, "frame.p95Ms": 33 },
    { platform: "linux" },
  );
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.reason ?? "", /^render had 1 non-finite timing sample, so render\.maxMs is NaN$/);
});

test("a missing metric without invalid-sample evidence keeps its violation shape (no reason)", () => {
  const result = evaluatePerformanceBudget(healthy, { "physics.bodyCount": { min: 1 } }, { platform: "linux" });
  assert.equal(result.passed, false);
  assert.equal(result.violations[0]?.reason, undefined);
  assert.equal("reason" in (result.violations[0] ?? {}), false);
});

test("the reason survives JSON serialisation of the report, unlike the NaN it explains", () => {
  const poisoned: RuntimePerformanceEvidence = {
    ...healthy,
    frame: calculatePercentiles([Number.NaN]),
    invalidSamples: { frame: 1 },
  };
  const result = evaluatePerformanceBudget(poisoned, { "frame.maxMs": 40 }, { platform: "linux" });
  const round = JSON.parse(JSON.stringify(result.violations)) as Array<Record<string, unknown>>;
  assert.equal(round[0]?.actual, null, "NaN is serialised as null");
  assert.match(String(round[0]?.reason), /non-finite timing sample/);
});

test("a healthy report has no reason on its violations", () => {
  const result = evaluatePerformanceBudget(healthy, { "frame.p95Ms": 5 }, { platform: "linux" });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.reason, undefined);
});
