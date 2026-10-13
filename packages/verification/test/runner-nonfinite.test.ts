import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceRunner,
  type AcceptanceManifest,
  type RuntimeInput,
  type RuntimeMetrics,
  type RuntimeProbe,
  type RuntimeSnapshot,
} from "../src/index.js";

/**
 * A probe whose snapshot and metrics are set by the test. It lets the numeric
 * assertions see values a real runtime can produce (NaN from 0/0, Infinity).
 */
class ScriptedProbe implements RuntimeProbe {
  constructor(
    private readonly state: Record<string, unknown>,
    private readonly metricValues: RuntimeMetrics = {},
  ) {}
  async start(_sceneId: string, _seed: number) {}
  async stop() {}
  async input(_event: RuntimeInput) {}
  async wait(_milliseconds: number) {}
  async snapshot(): Promise<RuntimeSnapshot> {
    return { running: true, state: this.state };
  }
  async logs() {
    return [];
  }
  async captureFrame() {
    return new Uint8Array();
  }
  async metrics() {
    return this.metricValues;
  }
}

type Step = AcceptanceManifest["steps"][number];

function manifest(steps: unknown[]): AcceptanceManifest {
  return {
    schemaVersion: 1,
    suite: "runner-nonfinite",
    seed: 0,
    target: "runtime",
    steps: steps as Step[],
  } as AcceptanceManifest;
}

async function runOne(probe: RuntimeProbe, step: unknown) {
  const report = await new AcceptanceRunner(probe).run(manifest([step]));
  return report;
}

test("assert.near fails when the observed value is NaN", async () => {
  const report = await runOne(
    new ScriptedProbe({ speed: Number.NaN }),
    { type: "assert.near", path: "state.speed", expected: 5, tolerance: 1 },
  );
  assert.equal(report.passed, false, "NaN is not within any tolerance of 5");
  assert.match(report.steps[0]?.message ?? "", /finite/i);
});

test("assert.near fails when the observed value is Infinity", async () => {
  const report = await runOne(
    new ScriptedProbe({ speed: Number.POSITIVE_INFINITY }),
    { type: "assert.near", path: "state.speed", expected: 5, tolerance: 1 },
  );
  assert.equal(report.passed, false);
});

test("assert.near still passes inside the tolerance and fails outside it", async () => {
  const pass = await runOne(
    new ScriptedProbe({ speed: 5.5 }),
    { type: "assert.near", path: "state.speed", expected: 5, tolerance: 1 },
  );
  assert.equal(pass.passed, true);
  const fail = await runOne(
    new ScriptedProbe({ speed: 7 }),
    { type: "assert.near", path: "state.speed", expected: 5, tolerance: 1 },
  );
  assert.equal(fail.passed, false);
});

test("assert.near with a NaN tolerance (manifest not parsed by zod) fails instead of passing", async () => {
  const report = await runOne(
    new ScriptedProbe({ speed: 99 }),
    { type: "assert.near", path: "state.speed", expected: 5, tolerance: Number.NaN },
  );
  assert.equal(report.passed, false);
});

test("assert.metricMax fails when the metric is NaN", async () => {
  const report = await runOne(
    new ScriptedProbe({}, { frameMs: Number.NaN } as RuntimeMetrics),
    { type: "assert.metricMax", metric: "frameMs", max: 16 },
  );
  assert.equal(report.passed, false, "a NaN metric must not satisfy a maximum");
  assert.match(report.steps[0]?.message ?? "", /NaN|finite/);
});

test("assert.metricMin fails when the metric is NaN", async () => {
  const report = await runOne(
    new ScriptedProbe({}, { fps: Number.NaN } as RuntimeMetrics),
    { type: "assert.metricMin", metric: "fps", min: 30 },
  );
  assert.equal(report.passed, false, "a NaN metric must not satisfy a minimum");
});

test("assert.metricMax / metricMin keep working for ordinary values", async () => {
  const probe = new ScriptedProbe({}, { frameMs: 10, fps: 60 } as RuntimeMetrics);
  assert.equal((await runOne(probe, { type: "assert.metricMax", metric: "frameMs", max: 16 })).passed, true);
  assert.equal((await runOne(probe, { type: "assert.metricMax", metric: "frameMs", max: 5 })).passed, false);
  assert.equal((await runOne(probe, { type: "assert.metricMin", metric: "fps", min: 30 })).passed, true);
  assert.equal((await runOne(probe, { type: "assert.metricMin", metric: "fps", min: 90 })).passed, false);
});

test("assert.equal does not treat NaN or Infinity as null", async () => {
  // JSON.stringify writes both as null, so the old comparison called them equal.
  const nan = await runOne(
    new ScriptedProbe({ hp: Number.NaN }),
    { type: "assert.equal", path: "state.hp", expected: null },
  );
  assert.equal(nan.passed, false, "NaN must not equal null");
  const inf = await runOne(
    new ScriptedProbe({ hp: Number.POSITIVE_INFINITY }),
    { type: "assert.equal", path: "state.hp", expected: null },
  );
  assert.equal(inf.passed, false, "Infinity must not equal null");
  const nested = await runOne(
    new ScriptedProbe({ pos: [1, Number.NaN, 3] }),
    { type: "assert.equal", path: "state.pos", expected: [1, null, 3] },
  );
  assert.equal(nested.passed, false, "NaN inside an array must not equal null");
});

test("assert.equal ignores object key order", async () => {
  const report = await runOne(
    new ScriptedProbe({ pos: { y: 2, x: 1, nested: { b: 2, a: 1 } } }),
    { type: "assert.equal", path: "state.pos", expected: { x: 1, y: 2, nested: { a: 1, b: 2 } } },
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps));
});

test("assert.equal still detects real differences and tolerates undefined-valued keys", async () => {
  const different = await runOne(
    new ScriptedProbe({ pos: { x: 1, y: 2 } }),
    { type: "assert.equal", path: "state.pos", expected: { x: 1, y: 3 } },
  );
  assert.equal(different.passed, false);
  const extraKey = await runOne(
    new ScriptedProbe({ pos: { x: 1, y: 2, z: 3 } }),
    { type: "assert.equal", path: "state.pos", expected: { x: 1, y: 2 } },
  );
  assert.equal(extraKey.passed, false, "an extra defined key is a difference");
  const undefinedKey = await runOne(
    new ScriptedProbe({ pos: { x: 1, model: undefined } }),
    { type: "assert.equal", path: "state.pos", expected: { x: 1 } },
  );
  assert.equal(undefinedKey.passed, true, "undefined-valued keys are absent keys, as in JSON");
  const arrays = await runOne(
    new ScriptedProbe({ list: [1, 2, 3] }),
    { type: "assert.equal", path: "state.list", expected: [1, 2] },
  );
  assert.equal(arrays.passed, false);
  const primitive = await runOne(
    new ScriptedProbe({ name: "orb" }),
    { type: "assert.equal", path: "state.name", expected: "orb" },
  );
  assert.equal(primitive.passed, true);
});
