import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceRunner,
  type AcceptanceManifest,
  type RuntimeMetrics,
  type RuntimeProbe,
} from "../src/index.js";

function probeWithMetrics(metricValues: unknown): RuntimeProbe {
  return {
    async start() {},
    async stop() {},
    async input() {},
    async wait() {},
    async snapshot() {
      return { running: true, state: {} };
    },
    async logs() {
      return [];
    },
    async captureFrame() {
      return new Uint8Array();
    },
    async metrics() {
      return metricValues as RuntimeMetrics;
    },
  } as RuntimeProbe;
}

async function runOne(probe: RuntimeProbe, step: unknown) {
  const manifest = {
    schemaVersion: 1,
    suite: "metric-thresholds",
    seed: 0,
    target: "runtime",
    steps: [step],
  } as unknown as AcceptanceManifest;
  return new AcceptanceRunner(probe).run(manifest);
}

test("metricMax/metricMin fail when the metric arrives as null (NaN over a JSON bridge)", async () => {
  const probe = probeWithMetrics({ frameMs: null });
  const max = await runOne(probe, { type: "assert.metricMax", metric: "frameMs", max: 16 });
  assert.equal(max.passed, false, "`null > 16` is false, so null used to satisfy any maximum");
  const min = await runOne(probe, { type: "assert.metricMin", metric: "frameMs", min: -5 });
  assert.equal(min.passed, false, "`null < -5` is false, so null used to satisfy that minimum");
});

test("metricMax/metricMin fail when the threshold is NaN or missing", async () => {
  const high = probeWithMetrics({ frameMs: 500 });
  for (const max of [Number.NaN, undefined]) {
    const report = await runOne(high, { type: "assert.metricMax", metric: "frameMs", max });
    assert.equal(report.passed, false, `max=${String(max)} must not make every value pass`);
  }
  const low = probeWithMetrics({ frameMs: -500 });
  for (const min of [Number.NaN, undefined]) {
    const report = await runOne(low, { type: "assert.metricMin", metric: "frameMs", min });
    assert.equal(report.passed, false, `min=${String(min)} must not make every value pass`);
  }
});

test("metricMax/metricMin still pass and fail normally for real numbers", async () => {
  const probe = probeWithMetrics({ frameMs: 10 });
  assert.equal((await runOne(probe, { type: "assert.metricMax", metric: "frameMs", max: 16 })).passed, true);
  assert.equal((await runOne(probe, { type: "assert.metricMax", metric: "frameMs", max: 5 })).passed, false);
  assert.equal((await runOne(probe, { type: "assert.metricMin", metric: "frameMs", min: 1 })).passed, true);
  assert.equal((await runOne(probe, { type: "assert.metricMin", metric: "frameMs", min: 50 })).passed, false);
});
