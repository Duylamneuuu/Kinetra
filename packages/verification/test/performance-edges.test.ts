import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  calculatePercentiles,
  evaluatePerformanceBudget,
  getPerformanceMetricValue,
  resolveBudgetForPlatform,
  type PerformanceReport,
  type RuntimePerformanceEvidence,
} from "../src/performance.js";
import { writePerformanceReport } from "../src/performance-report-file.js";

const timing = (p50Ms: number, p95Ms: number, p99Ms: number, maxMs: number) => ({
  p50Ms,
  p95Ms,
  p99Ms,
  maxMs,
});

const evidence: RuntimePerformanceEvidence = {
  sampleCount: 60,
  warmupSamples: 10,
  executionMode: "stepped",
  frame: timing(10, 16, 20, 24),
  simulation: timing(2, 3, 4, 5),
  render: timing(7, 11, 13, 15),
  renderer: {
    drawCalls: 30,
    triangles: 9000,
    points: 0,
    lines: 0,
    geometries: 12,
    textures: 4,
  },
  scene: {
    objectCount: 10,
    visibleObjectCount: 9,
    modelInstanceCount: 2,
    skinnedMeshCount: 1,
    activeAnimationMixerCount: 1,
  },
  physics: { bodyCount: 3, colliderCount: 4 },
};

/** Small deterministic PRNG (mulberry32) so the property tests never flake. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("performance property: percentiles are monotone, bounded by the samples, and order independent", () => {
  const random = prng(0xbeef);
  for (let round = 0; round < 300; round += 1) {
    const length = 1 + Math.floor(random() * 120);
    const samples = Array.from({ length }, () => Math.round(random() * 5000) / 100);
    const result = calculatePercentiles(samples);

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    assert.ok(result.p50Ms <= result.p95Ms, `p50 <= p95 (round ${round})`);
    assert.ok(result.p95Ms <= result.p99Ms, `p95 <= p99 (round ${round})`);
    assert.ok(result.p99Ms <= result.maxMs, `p99 <= max (round ${round})`);
    assert.ok(result.p50Ms >= min - 1e-9, `p50 >= min (round ${round})`);
    assert.equal(result.maxMs, max);

    // The result must not depend on the order the samples arrived in.
    const shuffled = [...samples];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    assert.deepEqual(calculatePercentiles(shuffled), result, `order independent (round ${round})`);
  }
});

test("performance: calculatePercentiles does not mutate its input and interpolates two samples", () => {
  const samples = [30, 10, 20];
  const copy = [...samples];
  calculatePercentiles(samples);
  assert.deepEqual(samples, copy);

  // Linear rank interpolation between exactly two samples.
  const two = calculatePercentiles([0, 100]);
  assert.equal(two.p50Ms, 50);
  assert.equal(two.p95Ms, 95);
  assert.equal(two.p99Ms, 99);
  assert.equal(two.maxMs, 100);
});

test("performance: calculatePercentiles reports NaN when any sample is non-finite", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = calculatePercentiles([1, 2, bad, 3]);
    assert.ok(Number.isNaN(result.p50Ms) && Number.isNaN(result.maxMs), `${bad} poisons the result`);
  }
});

test("performance: getPerformanceMetricValue ignores non-finite, non-numeric and prototype paths", () => {
  const poisoned = { ...evidence, frame: timing(Number.NaN, Number.POSITIVE_INFINITY, 1, 2) };
  assert.equal(getPerformanceMetricValue(poisoned, "frame.p50Ms"), undefined);
  assert.equal(getPerformanceMetricValue(poisoned, "frame.p95Ms"), undefined);
  assert.equal(getPerformanceMetricValue(poisoned, "frame.p99Ms"), 1);

  // Walking past a number, into an object (not a number), or through the prototype chain yields nothing.
  assert.equal(getPerformanceMetricValue(evidence, "frame.p50Ms.extra"), undefined);
  assert.equal(getPerformanceMetricValue(evidence, "frame"), undefined);
  assert.equal(getPerformanceMetricValue(evidence, ""), undefined);
  assert.equal(getPerformanceMetricValue(evidence, "constructor.length"), undefined);
  assert.equal(getPerformanceMetricValue(evidence, "__proto__.x"), undefined);
});

test("performance: min thresholds fail below the bound and a missing metric reports its own comparison", () => {
  const result = evaluatePerformanceBudget(
    evidence,
    { "scene.visibleObjectCount": { min: 20 }, "scene.nope": { min: 1 }, "frame.p95Ms": { max: 30 } },
    { platform: "linux" },
  );
  assert.equal(result.passed, false);
  assert.equal(result.thresholdCount, 3);
  assert.deepEqual(result.violations, [
    { metric: "scene.visibleObjectCount", limit: 20, actual: 9, comparison: "min" },
    { metric: "scene.nope", limit: 1, actual: Number.NaN, comparison: "min" },
  ]);
});

test("performance: a threshold with both bounds reports the bound that is broken", () => {
  const band = { "renderer.drawCalls": { min: 40, max: 50 } };
  const below = evaluatePerformanceBudget(evidence, band, { platform: "linux" });
  assert.deepEqual(below.violations, [
    { metric: "renderer.drawCalls", limit: 40, actual: 30, comparison: "min" },
  ]);
  const above = evaluatePerformanceBudget(
    { ...evidence, renderer: { ...evidence.renderer, drawCalls: 60 } },
    band,
    { platform: "linux" },
  );
  assert.deepEqual(above.violations, [
    { metric: "renderer.drawCalls", limit: 50, actual: 60, comparison: "max" },
  ]);
  const inside = evaluatePerformanceBudget(
    { ...evidence, renderer: { ...evidence.renderer, drawCalls: 45 } },
    band,
    { platform: "linux" },
  );
  assert.equal(inside.passed, true);
});

test("performance: a value exactly on the limit passes (bounds are inclusive)", () => {
  const result = evaluatePerformanceBudget(
    evidence,
    { "frame.p95Ms": { max: 16 }, "renderer.drawCalls": { min: 30 } },
    { platform: "linux" },
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test("performance: platform overrides apply per platform and unknown platforms use the base budget", () => {
  const spec = {
    profile: "ci",
    "frame.p95Ms": 100,
    windows: { "frame.p95Ms": { max: 5 } },
    linux: { "frame.p95Ms": { max: 50 } },
  };
  assert.equal(evaluatePerformanceBudget(evidence, spec, { platform: "win32" }).passed, false);
  assert.equal(evaluatePerformanceBudget(evidence, spec, { platform: "linux" }).passed, true);
  const darwin = evaluatePerformanceBudget(evidence, spec, { platform: "darwin" });
  assert.equal(darwin.passed, true);
  assert.equal(darwin.profile, "ci");
  assert.equal(darwin.platform, "darwin");
  assert.equal(resolveBudgetForPlatform(spec, "darwin").thresholds["frame.p95Ms"]?.max, 100);
  assert.equal(resolveBudgetForPlatform(spec, "win32").thresholds["frame.p95Ms"]?.max, 5);
});

test("performance: an unusable platform override is reported with its platform and fails the budget", () => {
  const spec = { "frame.p95Ms": 100, linux: { "frame.p99Ms": "fast", "frame.maxMs": { max: Number.NaN } } };
  const resolved = resolveBudgetForPlatform(spec, "linux");
  assert.deepEqual(resolved.invalid, ["linux:frame.p99Ms", "linux:frame.maxMs"]);
  const result = evaluatePerformanceBudget(evidence, spec, { platform: "linux" });
  assert.equal(result.passed, false);
  assert.match(result.error ?? "", /performance\.budgetInvalid/);
  assert.match(result.error ?? "", /linux:frame\.p99Ms/);
  // The valid threshold is still evaluated.
  assert.equal(result.thresholdCount, 1);

  // The same spec on another platform ignores the linux block entirely.
  assert.deepEqual(resolveBudgetForPlatform(spec, "darwin").invalid, []);
});

test("performance: an override can add a bound to a base threshold without dropping the base one", () => {
  const spec = { "frame.p95Ms": { max: 30 }, linux: { "frame.p95Ms": { min: 1 } } };
  assert.deepEqual(resolveBudgetForPlatform(spec, "linux").thresholds["frame.p95Ms"], { max: 30, min: 1 });
});

test("performance: a JSON budget with a __proto__ key cannot change the threshold set", () => {
  const spec = JSON.parse('{"__proto__": {"max": 1}, "frame.p95Ms": 100}') as unknown;
  const resolved = resolveBudgetForPlatform(spec, "linux");
  assert.deepEqual(Object.keys(resolved.thresholds), ["frame.p95Ms"]);
  assert.equal(Object.getPrototypeOf({}).max, undefined, "global Object.prototype stays clean");
  const result = evaluatePerformanceBudget(evidence, spec, { platform: "linux" });
  assert.equal(result.passed, true);
  assert.equal(result.thresholdCount, 1);
});

test("performance: budget wrapper shapes ({ budget }, { budgets }) resolve like the flat shape", () => {
  const flat = resolveBudgetForPlatform({ "frame.p95Ms": 20 }, "linux").thresholds;
  assert.deepEqual(resolveBudgetForPlatform({ budget: { "frame.p95Ms": 20 } }, "linux").thresholds, flat);
  assert.deepEqual(resolveBudgetForPlatform({ budgets: { "frame.p95Ms": 20 } }, "linux").thresholds, flat);
  for (const nothing of [null, undefined, 5, "budget", true]) {
    assert.deepEqual(resolveBudgetForPlatform(nothing, "linux"), { thresholds: {}, invalid: [] });
  }
});

test("performance: writePerformanceReport creates parent directories and writes pretty JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-perf-report-"));
  try {
    const target = join(dir, "nested", "deeper", "performance-report.json");
    const report: PerformanceReport = {
      scene: "arena",
      suite: "perf",
      runtimeCommit: "abc1234",
      measuredEvidence: evidence,
      violations: [{ metric: "frame.p95Ms", limit: 10, actual: 16, comparison: "max" }],
      passed: false,
    };
    await writePerformanceReport(target, report);
    const text = await readFile(target, "utf8");
    assert.ok(text.includes("\n  "), "indented with two spaces");
    assert.deepEqual(JSON.parse(text), report);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("performance: writePerformanceReport replaces an existing report and serializes NaN as null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-perf-report-"));
  try {
    const target = join(dir, "performance-report.json");
    await writeFile(target, "stale content that is much longer than the new report ".repeat(50), "utf8");
    const evaluation = evaluatePerformanceBudget(evidence, { "frame.nope": { max: 1 } }, { platform: "linux" });
    await writePerformanceReport(target, {
      violations: evaluation.violations,
      passed: evaluation.passed,
    });
    const parsed = JSON.parse(await readFile(target, "utf8")) as PerformanceReport;
    assert.equal(parsed.passed, false);
    // JSON has no NaN: a metric that was never measured is written as null, never as a number.
    assert.equal((parsed.violations[0] as unknown as { actual: unknown }).actual, null);
    assert.equal(parsed.violations[0]?.metric, "frame.nope");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("performance: writePerformanceReport rejects when the target is an existing directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-perf-report-"));
  try {
    await assert.rejects(writePerformanceReport(dir, { violations: [], passed: true }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
