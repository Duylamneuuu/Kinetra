import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceRunner,
  acceptanceManifestSchema,
  encodePng,
  type AcceptanceManifest,
  type RuntimeInput,
  type RuntimeProbe,
  type RuntimeSnapshot,
} from "../src/index.js";

function solidPng(r: number, g: number, b: number): Uint8Array {
  const width = 16;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([r, g, b, 255], i * 4);
  }
  return encodePng({ width, height, data });
}

/** Probe that hands out a scripted sequence of frames. */
class FrameProbe implements RuntimeProbe {
  state: RuntimeSnapshot = { running: false, state: {} };
  #frames: Uint8Array[];
  #next = 0;

  constructor(frames: Uint8Array[]) {
    this.#frames = frames;
  }
  async start(sceneId: string, _seed: number) {
    this.state = { running: true, sceneId, state: {} };
  }
  async stop() {
    this.state = { running: false, state: {} };
  }
  async input(_event: RuntimeInput) {}
  async wait(_milliseconds: number) {}
  async snapshot() {
    return structuredClone(this.state);
  }
  async logs() {
    return [];
  }
  async captureFrame() {
    const frame = this.#frames[Math.min(this.#next, this.#frames.length - 1)];
    this.#next += 1;
    assert.ok(frame, "FrameProbe needs at least one frame");
    return frame;
  }
  async metrics() {
    return {};
  }
}

function manifest(steps: unknown[]): AcceptanceManifest {
  return acceptanceManifestSchema.parse({
    schemaVersion: 1,
    suite: "visual-runner",
    seed: 0,
    target: "runtime",
    steps,
  });
}

test("assert.visualSimilarity passes for identical frames and records the comparison", async () => {
  const probe = new FrameProbe([solidPng(10, 20, 30), solidPng(10, 20, 30)]);
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: "main" },
      { type: "capture.frame", id: "ref" },
      { type: "assert.visualSimilarity", referenceCaptureId: "ref" },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps));
  const similarity = report.steps.find((step) => step.type === "assert.visualSimilarity");
  assert.equal(similarity?.visualComparison?.similar, true);
  assert.equal(similarity?.visualComparison?.changedPixelRatio, 0);
});

test("assert.visualSimilarity reports the thresholds and measurements when frames differ", async () => {
  const probe = new FrameProbe([solidPng(0, 0, 0), solidPng(255, 255, 255)]);
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: "main" },
      { type: "capture.frame", id: "ref" },
      { type: "assert.visualSimilarity", referenceCaptureId: "ref", maxChangedPixelRatio: 0.1 },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, false);
  const failed = report.steps.find((step) => !step.passed);
  assert.equal(failed?.type, "assert.visualSimilarity");
  assert.match(failed?.message ?? "", /visual\.perceptualMismatch/);
  assert.deepEqual(failed?.expected, {
    maxChangedPixelRatio: 0.1,
    maxPerceptualHashDistance: 8,
    maxMeanAbsoluteDifference: 0.08,
  });
  const actual = failed?.actual as { changedPixelRatio: number; referenceCaptureId: string };
  assert.equal(actual.changedPixelRatio, 1);
  assert.equal(actual.referenceCaptureId, "ref");
});

test("a rejected visual threshold surfaces VisualError code and details on the step result", async () => {
  const probe = new FrameProbe([solidPng(1, 2, 3)]);
  // Bypass the manifest schema (which now rejects this) to prove the runner
  // still reports the helper's structured error instead of a bare message.
  const raw = {
    schemaVersion: 1,
    suite: "visual-runner",
    seed: 0,
    target: "runtime",
    steps: [
      { type: "runtime.start", sceneId: "main" },
      { type: "capture.frame", id: "ref" },
      { type: "assert.visualSimilarity", referenceCaptureId: "ref", pixelDiffThreshold: 9999 },
      { type: "runtime.stop" },
    ],
  } as unknown as AcceptanceManifest;
  const report = await new AcceptanceRunner(probe).run(raw);
  assert.equal(report.passed, false);
  const failed = report.steps.find((step) => !step.passed);
  assert.equal(failed?.type, "assert.visualSimilarity");
  assert.match(failed?.message ?? "", /visual\.invalidThreshold/);
  assert.deepEqual(failed?.visualError, {
    code: "visual.invalidThreshold",
    details: { threshold: "pixelDiffThreshold", value: 9999, max: 765 },
  });
});

test("an undecodable capture fails capture.frame with visual.decodeFailed", async () => {
  // Valid PNG magic bytes followed by garbage: decodePng must reject it.
  const bad = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const probe = new FrameProbe([bad]);
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: "main" },
      { type: "capture.frame", id: "broken" },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, false);
  const failed = report.steps.find((step) => !step.passed);
  assert.equal(failed?.type, "capture.frame");
  assert.equal(failed?.visualError?.code, "visual.decodeFailed");
});

test("pixelDiffThreshold above 765 (the RGB absolute-sum maximum) is rejected by the manifest schema", () => {
  const step = (pixelDiffThreshold: number) => ({
    type: "assert.visualSimilarity",
    referenceCaptureId: "ref",
    pixelDiffThreshold,
  });
  const base = { schemaVersion: 1, suite: "s", seed: 0, target: "runtime" } as const;
  assert.equal(acceptanceManifestSchema.safeParse({ ...base, steps: [step(765)] }).success, true);
  assert.equal(acceptanceManifestSchema.safeParse({ ...base, steps: [step(0)] }).success, true);
  assert.equal(acceptanceManifestSchema.safeParse({ ...base, steps: [step(766)] }).success, false);
  assert.equal(acceptanceManifestSchema.safeParse({ ...base, steps: [step(-1)] }).success, false);
  assert.equal(acceptanceManifestSchema.safeParse({ ...base, steps: [step(1.5)] }).success, false);
});

test("assert.visualDifference fails with thresholds when frames are identical", async () => {
  const probe = new FrameProbe([solidPng(5, 5, 5), solidPng(5, 5, 5)]);
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: "main" },
      { type: "capture.frame", id: "ref" },
      { type: "assert.visualDifference", referenceCaptureId: "ref" },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, false);
  const failed = report.steps.find((step) => !step.passed);
  assert.match(failed?.message ?? "", /perceptually identical/);
  assert.deepEqual(failed?.expected, { minChangedPixelRatio: 0.05, minPerceptualHashDistance: 6 });
});

test("unknown reference capture ids list the available captures", async () => {
  const probe = new FrameProbe([solidPng(5, 5, 5)]);
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: "main" },
      { type: "capture.frame", id: "known" },
      { type: "assert.visualSimilarity", referenceCaptureId: "missing" },
      { type: "runtime.stop" },
    ]),
  );
  assert.equal(report.passed, false);
  const failed = report.steps.find((step) => !step.passed);
  assert.match(failed?.message ?? "", /Reference capture ID "missing" not found/);
  assert.match(failed?.message ?? "", /known/);
});
