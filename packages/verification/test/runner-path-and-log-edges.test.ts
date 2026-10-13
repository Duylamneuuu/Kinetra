import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceRunner,
  type AcceptanceManifest,
  type RuntimeLog,
  type RuntimeProbe,
  type RuntimeSnapshot,
} from "../src/index.js";

/**
 * Edge cases of the AcceptanceRunner that only the real-Electron suite (or nothing) touched:
 * the `wait` step, the `runtime.step` fallback to `wait`, path traversal through non-object
 * data, the missing-path diagnostic (empty / truncated key lists) and `assert.logAbsent`
 * failing on level and `messageIncludes`.
 */

class EdgeProbe implements RuntimeProbe {
  readonly waits: number[] = [];
  constructor(
    private readonly state: Record<string, unknown> = {},
    private readonly logEntries: RuntimeLog[] = [],
  ) {}
  async start(_sceneId: string, _seed: number) {}
  async stop() {}
  async input() {}
  async wait(milliseconds: number) {
    this.waits.push(milliseconds);
  }
  async snapshot(): Promise<RuntimeSnapshot> {
    return { running: true, state: this.state };
  }
  async logs() {
    return this.logEntries;
  }
  async captureFrame() {
    return new Uint8Array();
  }
  async metrics() {
    return {};
  }
}

type Step = AcceptanceManifest["steps"][number];

async function runSteps(probe: RuntimeProbe, steps: unknown[]) {
  const manifest = {
    schemaVersion: 1,
    suite: "runner-path-and-log-edges",
    seed: 0,
    target: "runtime",
    steps: steps as Step[],
  } as AcceptanceManifest;
  return new AcceptanceRunner(probe).run(manifest);
}

test("a wait step forwards the exact milliseconds to the probe", async () => {
  const probe = new EdgeProbe();
  const report = await runSteps(probe, [
    { type: "wait", milliseconds: 250 },
    { type: "wait", milliseconds: 0 },
  ]);
  assert.equal(report.passed, true, JSON.stringify(report.steps));
  assert.deepEqual(probe.waits, [250, 0]);
});

test("runtime.step on a probe without step() waits steps x deltaSeconds in milliseconds", async () => {
  const probe = new EdgeProbe();
  const report = await runSteps(probe, [
    { type: "runtime.step", steps: 3, deltaSeconds: 0.5 },
    { type: "runtime.step" },
  ]);
  assert.equal(report.passed, true, JSON.stringify(report.steps));
  assert.equal(probe.waits[0], 1500);
  assert.ok(Math.abs((probe.waits[1] ?? 0) - 1000 / 60) < 1e-9, "default is one 60 Hz frame");
});

test("reading through a primitive fails the step with a traversal message and no diagnostic", async () => {
  const report = await runSteps(new EdgeProbe({ name: "orb" }), [
    { type: "assert.equal", path: "state.name.length", expected: 3 },
  ]);
  assert.equal(report.passed, false);
  const step = report.steps[0];
  assert.match(step?.error ?? "", /Cannot read "state\.name\.length": "length" traverses non-object data/);
  assert.equal(step?.diagnostics, undefined, "a traversal error is not a missing-path diagnostic");
  assert.equal(step?.expected, 3, "the expectation is still reported");
});

test("reading through null fails the step instead of throwing a raw TypeError", async () => {
  const report = await runSteps(new EdgeProbe({ target: null }), [
    { type: "assert.near", path: "state.target.x", expected: 0, tolerance: 1 },
  ]);
  assert.equal(report.passed, false);
  assert.match(report.steps[0]?.error ?? "", /traverses non-object data/);
});

test("a missing path on an empty object lists (none) and an empty availableKeys", async () => {
  const report = await runSteps(new EdgeProbe({ hero: {} }), [
    { type: "assert.equal", path: "state.hero.hp", expected: 10 },
  ]);
  assert.equal(report.passed, false);
  const step = report.steps[0];
  assert.match(step?.error ?? "", /Missing "hp" while reading "state\.hero\.hp"\. Available keys: \(none\)$/);
  assert.deepEqual(step?.diagnostics, {
    kind: "missing_path",
    path: "state.hero.hp",
    missingSegment: "hp",
    availableKeys: [],
  });
});

test("a missing path next to many keys shows a sorted, truncated list with the remainder counted", async () => {
  const hero: Record<string, number> = {};
  // 15 keys inserted out of order: the diagnostic must sort them and keep only the first 12.
  for (const key of ["o", "n", "m", "l", "k", "j", "i", "h", "g", "f", "e", "d", "c", "b", "a"]) hero[key] = 1;
  const report = await runSteps(new EdgeProbe({ hero }), [
    { type: "assert.equal", path: "state.hero.hp", expected: 1 },
  ]);
  const step = report.steps[0];
  assert.equal(step?.passed, false);
  assert.match(step?.error ?? "", /Available keys: a, b, c, d, e, f, g, h, i, j, k, l \(\+3 more\)$/);
  assert.deepEqual(step?.diagnostics?.availableKeys, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]);
});

test("exactly twelve keys are listed in full without a (+N more) suffix", async () => {
  const hero: Record<string, number> = {};
  for (const key of "abcdefghijkl") hero[key] = 1;
  const report = await runSteps(new EdgeProbe({ hero }), [
    { type: "assert.equal", path: "state.hero.hp", expected: 1 },
  ]);
  const message = report.steps[0]?.error ?? "";
  assert.match(message, /Available keys: a, b, c, d, e, f, g, h, i, j, k, l$/);
  assert.doesNotMatch(message, /more\)/);
});

test("inherited properties do not count as present when a path is read", async () => {
  const report = await runSteps(new EdgeProbe({}), [
    { type: "assert.equal", path: "state.toString", expected: undefined },
  ]);
  assert.equal(report.passed, false, "state.toString is inherited, not an own key");
  assert.equal(report.steps[0]?.diagnostics?.missingSegment, "toString");
});

test("assert.logAbsent ignores logs below the minimum level and passes", async () => {
  const report = await runSteps(
    new EdgeProbe({}, [
      { level: "debug", message: "tick" },
      { level: "info", message: "loaded" },
      { level: "warning", message: "slow frame" },
    ]),
    [{ type: "assert.logAbsent", minimumLevel: "error" }],
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps));
});

test("assert.logAbsent fails on a warning when the minimum level is warning and reports it", async () => {
  const report = await runSteps(
    new EdgeProbe({}, [
      { level: "info", message: "loaded" },
      { level: "warning", message: "texture missing" },
      { level: "error", message: "later error" },
    ]),
    [{ type: "assert.logAbsent", minimumLevel: "warning" }],
  );
  assert.equal(report.passed, false);
  const step = report.steps[0];
  assert.equal(step?.error, "Unexpected warning log: texture missing", "first offending log wins");
  assert.equal(step?.expected, "no logs with level >= warning");
  assert.equal(step?.actual, "[warning] texture missing");
});

test("assert.logAbsent with messageIncludes only trips on matching messages", async () => {
  const logs: RuntimeLog[] = [
    { level: "error", message: "audio device busy" },
    { level: "warning", message: "shader recompiled" },
  ];
  const unrelated = await runSteps(new EdgeProbe({}, logs), [
    { type: "assert.logAbsent", minimumLevel: "error", messageIncludes: "shader" },
  ]);
  assert.equal(unrelated.passed, true, "the only matching message is a warning, below the minimum");

  const related = await runSteps(new EdgeProbe({}, logs), [
    { type: "assert.logAbsent", minimumLevel: "warning", messageIncludes: "shader" },
  ]);
  assert.equal(related.passed, false);
  assert.equal(related.steps[0]?.expected, 'no logs with level >= warning containing "shader"');
  assert.equal(related.steps[0]?.actual, "[warning] shader recompiled");
});
