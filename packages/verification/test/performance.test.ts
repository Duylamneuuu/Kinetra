import assert from "node:assert/strict";
import test from "node:test";

import {
  calculatePercentiles,
  evaluatePerformanceBudget,
  getPerformanceMetricValue,
  resolveBudgetForPlatform,
  type RuntimePerformanceEvidence,
} from "../src/performance.js";

const mockEvidence: RuntimePerformanceEvidence = {
  sampleCount: 100,
  warmupSamples: 20,
  executionMode: "stepped",
  frame: {
    p50Ms: 12.5,
    p95Ms: 18.2,
    p99Ms: 22.1,
    maxMs: 25.4,
  },
  simulation: {
    p50Ms: 3.1,
    p95Ms: 5.4,
    p99Ms: 6.8,
    maxMs: 7.9,
  },
  render: {
    p50Ms: 8.9,
    p95Ms: 12.1,
    p99Ms: 14.8,
    maxMs: 17.2,
  },
  renderer: {
    drawCalls: 45,
    triangles: 12500,
    points: 0,
    lines: 10,
    geometries: 18,
    textures: 6,
  },
  scene: {
    objectCount: 24,
    visibleObjectCount: 22,
    modelInstanceCount: 3,
    skinnedMeshCount: 2,
    activeAnimationMixerCount: 2,
  },
  physics: {
    bodyCount: 5,
    colliderCount: 8,
  },
};

test("performance: calculatePercentiles handles edge cases and maintains monotonicity", () => {
  // Empty
  assert.deepEqual(calculatePercentiles([]), {
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
  });

  // Single sample
  const single = calculatePercentiles([42.5]);
  assert.equal(single.p50Ms, 42.5);
  assert.equal(single.p95Ms, 42.5);
  assert.equal(single.p99Ms, 42.5);
  assert.equal(single.maxMs, 42.5);

  // Uniform samples
  const uniform = calculatePercentiles([10, 10, 10, 10, 10]);
  assert.equal(uniform.p50Ms, 10);
  assert.equal(uniform.p95Ms, 10);
  assert.equal(uniform.p99Ms, 10);
  assert.equal(uniform.maxMs, 10);

  // 100 samples with tail spike (top 10% elevated)
  const samples = Array.from({ length: 90 }, () => 10);
  samples.push(15, 20, 25, 30, 35, 40, 45, 50, 60, 100);
  const result = calculatePercentiles(samples);

  assert.equal(result.p50Ms, 10);
  assert.ok(result.p95Ms >= 30, `p95Ms (${result.p95Ms}) should reflect tail`);
  assert.ok(result.p99Ms >= 60, `p99Ms (${result.p99Ms}) should reflect 99th percentile`);
  assert.equal(result.maxMs, 100);

  // Monotonicity invariant: p50 <= p95 <= p99 <= max
  assert.ok(result.p50Ms <= result.p95Ms);
  assert.ok(result.p95Ms <= result.p99Ms);
  assert.ok(result.p99Ms <= result.maxMs);
});

test("performance: getPerformanceMetricValue extracts dot-separated paths truthfully", () => {
  assert.equal(getPerformanceMetricValue(mockEvidence, "renderer.drawCalls"), 45);
  assert.equal(getPerformanceMetricValue(mockEvidence, "renderer.triangles"), 12500);
  assert.equal(getPerformanceMetricValue(mockEvidence, "frame.p95Ms"), 18.2);
  assert.equal(getPerformanceMetricValue(mockEvidence, "simulation.maxMs"), 7.9);
  assert.equal(getPerformanceMetricValue(mockEvidence, "scene.modelInstanceCount"), 3);
  assert.equal(getPerformanceMetricValue(mockEvidence, "physics.bodyCount"), 5);

  // Unknown path
  assert.equal(getPerformanceMetricValue(mockEvidence, "renderer.nonExistent"), undefined);
  assert.equal(getPerformanceMetricValue(mockEvidence, "nonExistent.sub"), undefined);
});

test("performance: resolveBudgetForPlatform merges base and platform overrides", () => {
  const spec = {
    profile: "test-profile",
    budgets: {
      "renderer.drawCalls": 50,
      "frame.p95Ms": 25,
    },
    windows: {
      "frame.p95Ms": 20,
    },
    linux: {
      "frame.p95Ms": 60,
    },
  };

  const win = resolveBudgetForPlatform(spec, "win32");
  assert.equal(win.profile, "test-profile");
  assert.equal(win.thresholds["renderer.drawCalls"]?.max, 50);
  assert.equal(win.thresholds["frame.p95Ms"]?.max, 20);

  const linux = resolveBudgetForPlatform(spec, "linux");
  assert.equal(linux.thresholds["renderer.drawCalls"]?.max, 50);
  assert.equal(linux.thresholds["frame.p95Ms"]?.max, 60);
});

test("performance: evaluatePerformanceBudget detects passes and multiple violations", () => {
  // Passing budget
  const passBudget = {
    "renderer.drawCalls": { max: 100 },
    "renderer.triangles": { max: 20000 },
    "frame.p95Ms": { max: 30 },
  };
  const passResult = evaluatePerformanceBudget(mockEvidence, passBudget);
  assert.equal(passResult.passed, true);
  assert.equal(passResult.violations.length, 0);

  // Multiple violations simultaneously
  const failBudget = {
    "renderer.drawCalls": { max: 30 }, // actual is 45 -> fails
    "frame.p95Ms": { max: 15 }, // actual is 18.2 -> fails
    "scene.objectCount": { max: 50 }, // actual is 24 -> passes
    "physics.bodyCount": { min: 10 }, // actual is 5 -> fails min
  };
  const failResult = evaluatePerformanceBudget(mockEvidence, failBudget);
  assert.equal(failResult.passed, false);
  assert.equal(failResult.violations.length, 3);

  const drawCallViolation = failResult.violations.find((v) => v.metric === "renderer.drawCalls");
  assert.ok(drawCallViolation);
  assert.equal(drawCallViolation.actual, 45);
  assert.equal(drawCallViolation.limit, 30);
  assert.equal(drawCallViolation.comparison, "max");

  const p95Violation = failResult.violations.find((v) => v.metric === "frame.p95Ms");
  assert.ok(p95Violation);
  assert.equal(p95Violation.actual, 18.2);
  assert.equal(p95Violation.limit, 15);
  assert.equal(p95Violation.comparison, "max");

  const minViolation = failResult.violations.find((v) => v.metric === "physics.bodyCount");
  assert.ok(minViolation);
  assert.equal(minViolation.actual, 5);
  assert.equal(minViolation.limit, 10);
  assert.equal(minViolation.comparison, "min");
});
