import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AcceptanceRunner,
  encodePng,
  type AcceptanceManifest,
  type AcceptanceReport,
  type RuntimePerformanceEvidence,
  type RuntimeProbe,
  type VisualCritiqueProvider,
} from "../src/index.js";

/**
 * Unit coverage for the AcceptanceRunner steps that only the real-Electron suite
 * exercised before: screenshot, visual assertions, critique and performance.
 * Everything runs against an in-memory probe so it needs no display.
 */

type Step = AcceptanceManifest["steps"][number];

function solid(r: number, g: number, b: number, size = 32): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width: size, height: size, data });
}

/** Deterministic textured frame: horizontal gradient + checker so variance and entropy are high. */
function textured(invert = false, size = 64): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const checker = ((x >> 3) + (y >> 3)) % 2 === 0 ? 255 : 0;
      const gradient = Math.floor((x / (size - 1)) * 255);
      let v = (checker + gradient) % 256;
      if (invert) v = 255 - v;
      data[i] = v;
      data[i + 1] = (v * 3) % 256;
      data[i + 2] = 255 - v;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, data });
}

class FrameProbe implements RuntimeProbe {
  frames: Uint8Array[];
  captureCalls = 0;
  constructor(frames: Uint8Array[]) {
    this.frames = frames;
  }
  async start() {}
  async stop() {}
  async input() {}
  async wait() {}
  async snapshot() {
    return { running: true, state: { score: 3 } };
  }
  async logs() {
    return [{ level: "info" as const, message: "ok" }];
  }
  async captureFrame() {
    const frame = this.frames[Math.min(this.captureCalls, this.frames.length - 1)];
    this.captureCalls++;
    return frame as Uint8Array;
  }
  async metrics() {
    return {};
  }
}

class PerfProbe extends FrameProbe {
  samples = 0;
  lastSampleOptions: unknown;
  constructor(
    frames: Uint8Array[],
    private readonly evidence: RuntimePerformanceEvidence,
  ) {
    super(frames);
  }
  async samplePerformance(options?: unknown): Promise<RuntimePerformanceEvidence> {
    this.samples++;
    this.lastSampleOptions = options;
    return this.evidence;
  }
}

function manifest(steps: unknown[]): AcceptanceManifest {
  return {
    schemaVersion: 1,
    suite: "runner-steps",
    seed: 0,
    target: "runtime",
    steps: steps as Step[],
  } as AcceptanceManifest;
}

function failedStep(report: AcceptanceReport) {
  const failed = report.steps.find((s) => !s.passed);
  assert.ok(failed, "expected a failed step");
  return failed;
}

const PERF: RuntimePerformanceEvidence = {
  sampleCount: 60,
  warmupSamples: 10,
  executionMode: "stepped",
  frame: { p50Ms: 5, p95Ms: 8, p99Ms: 9, maxMs: 12 },
  simulation: { p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 },
  render: { p50Ms: 3, p95Ms: 5, p99Ms: 6, maxMs: 7 },
  renderer: { drawCalls: 20, triangles: 5000, points: 0, lines: 0, geometries: 5, textures: 2 },
  scene: {
    objectCount: 10,
    visibleObjectCount: 9,
    modelInstanceCount: 1,
    skinnedMeshCount: 0,
    activeAnimationMixerCount: 0,
  },
  physics: { bodyCount: 2, colliderCount: 2 },
};

// ---- screenshots ---------------------------------------------------------

test("assert.screenshotSha256 passes on a matching hash and reports both hashes on mismatch", async () => {
  const frame = textured();
  const sha = createHash("sha256").update(frame).digest("hex");
  const ok = await new AcceptanceRunner(new FrameProbe([frame])).run(
    manifest([{ type: "assert.screenshotSha256", sha256: sha }]),
  );
  assert.equal(ok.passed, true);

  const bad = await new AcceptanceRunner(new FrameProbe([frame])).run(
    manifest([{ type: "assert.screenshotSha256", sha256: "0".repeat(64) }]),
  );
  assert.equal(bad.passed, false);
  const step = failedStep(bad);
  assert.match(step.error ?? step.message ?? "", /Screenshot hash mismatch/);
  assert.equal(step.expected, "0".repeat(64));
  assert.equal(step.actual, sha);
});

test("assert.screenshotValidPng enforces minBytes and the PNG magic header", async () => {
  const frame = textured();
  const pass = await new AcceptanceRunner(new FrameProbe([frame])).run(
    manifest([{ type: "assert.screenshotValidPng", minBytes: 100 }]),
  );
  assert.equal(pass.passed, true);

  const small = await new AcceptanceRunner(new FrameProbe([frame])).run(
    manifest([{ type: "assert.screenshotValidPng", minBytes: frame.length + 1 }]),
  );
  assert.equal(small.passed, false);
  assert.match(failedStep(small).error ?? failedStep(small).message ?? "", /Screenshot too small/);

  const junk = new Uint8Array(2000).fill(7);
  const notPng = await new AcceptanceRunner(new FrameProbe([junk])).run(
    manifest([{ type: "assert.screenshotValidPng" }]),
  );
  assert.equal(notPng.passed, false);
  const step = failedStep(notPng);
  assert.match(step.error ?? step.message ?? "", /not a valid PNG/);
  assert.equal(step.actual, "07 07 07 07 07 07 07 07");
});

test("capture.frame stores artifacts only when saveArtifact and artifactDir are both set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-runner-steps-"));
  try {
    const steps = [
      { type: "capture.frame", id: "weird id/../x", saveArtifact: true },
      { type: "capture.frame", id: "unsaved" },
    ];
    const report = await new AcceptanceRunner(new FrameProbe([textured()]), { artifactDir: dir }).run(
      manifest(steps),
    );
    assert.equal(report.passed, true);
    const files = await readdir(dir);
    // The id is sanitised so it cannot escape the artifact directory.
    assert.deepEqual(files, ["weird_id____x.png"]);
    assert.ok(report.steps[0]?.visualEvidence, "capture.frame reports visual evidence");

    const noDir = await mkdtemp(join(tmpdir(), "kinetra-runner-steps-"));
    try {
      await new AcceptanceRunner(new FrameProbe([textured()])).run(
        manifest([{ type: "capture.frame", id: "a", saveArtifact: true }]),
      );
      assert.deepEqual(await readdir(noDir), []);
    } finally {
      await rm(noDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- assert.visualNotBlank -----------------------------------------------

test("assert.visualNotBlank accepts a textured live frame and rejects a solid one", async () => {
  const good = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "assert.visualNotBlank" }]),
  );
  assert.equal(good.passed, true, JSON.stringify(good.steps));
  assert.ok(good.steps[0]?.visualEvidence);

  const blank = await new AcceptanceRunner(new FrameProbe([solid(10, 10, 10)])).run(
    manifest([{ type: "assert.visualNotBlank" }]),
  );
  assert.equal(blank.passed, false);
  assert.match(failedStep(blank).error ?? failedStep(blank).message ?? "", /Visual blank frame detected/);
});

test("assert.visualNotBlank checks a stored capture instead of grabbing a new frame", async () => {
  const probe = new FrameProbe([solid(0, 0, 0), textured()]);
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "capture.frame", id: "dark" },
      { type: "assert.visualNotBlank", captureId: "dark" },
    ]),
  );
  assert.equal(report.passed, false);
  assert.equal(probe.captureCalls, 1, "the stored capture must be used, not a fresh frame");
});

test("assert.visualNotBlank with an unknown captureId lists the available captures", async () => {
  const report = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([
      { type: "capture.frame", id: "first" },
      { type: "assert.visualNotBlank", captureId: "missing" },
    ]),
  );
  assert.equal(report.passed, false);
  const message = failedStep(report).error ?? failedStep(report).message ?? "";
  assert.match(message, /Unknown capture ID "missing"/);
  assert.match(message, /first/);
});

test("assert.visualNotBlank honours explicit thresholds", async () => {
  const strict = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "assert.visualNotBlank", minEntropy: 1e9 }]),
  );
  assert.equal(strict.passed, false, "an unreachable entropy threshold must fail even a textured frame");
  assert.match(failedStep(strict).error ?? failedStep(strict).message ?? "", /entropy/);

  const opaque = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "assert.visualNotBlank", minOpaqueRatio: 1.0, minEntropy: 0 }]),
  );
  assert.equal(opaque.passed, true, "a fully opaque frame meets minOpaqueRatio 1");
});

// ---- similarity / difference ---------------------------------------------

test("assert.visualSimilarity passes for identical frames and fails for different ones", async () => {
  const same = await new AcceptanceRunner(new FrameProbe([textured(), textured()])).run(
    manifest([
      { type: "capture.frame", id: "ref" },
      { type: "assert.visualSimilarity", referenceCaptureId: "ref" },
    ]),
  );
  assert.equal(same.passed, true, JSON.stringify(same.steps));
  assert.equal(same.steps[1]?.visualComparison?.similar, true);

  const different = await new AcceptanceRunner(new FrameProbe([textured(), textured(true)])).run(
    manifest([
      { type: "capture.frame", id: "ref" },
      { type: "assert.visualSimilarity", referenceCaptureId: "ref" },
    ]),
  );
  assert.equal(different.passed, false);
  const step = failedStep(different);
  assert.match(step.error ?? step.message ?? "", /visual\.perceptualMismatch/);
  assert.match(step.error ?? step.message ?? "", /current/);
});

test("assert.visualSimilarity reports an unknown reference or actual capture id", async () => {
  const noRef = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "assert.visualSimilarity", referenceCaptureId: "nope" }]),
  );
  assert.match(failedStep(noRef).error ?? failedStep(noRef).message ?? "", /Reference capture ID "nope" not found/);

  const noActual = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([
      { type: "capture.frame", id: "ref" },
      { type: "assert.visualSimilarity", referenceCaptureId: "ref", actualCaptureId: "ghost" },
    ]),
  );
  assert.match(failedStep(noActual).error ?? failedStep(noActual).message ?? "", /Actual capture ID "ghost" not found/);
});

test("assert.visualSimilarity compares two stored captures without touching the probe", async () => {
  const probe = new FrameProbe([textured(), textured(true)]);
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "capture.frame", id: "a" },
      { type: "capture.frame", id: "b" },
      {
        type: "assert.visualSimilarity",
        referenceCaptureId: "a",
        actualCaptureId: "b",
        maxChangedPixelRatio: 1,
        maxPerceptualHashDistance: 64,
        maxMeanAbsoluteDifference: 1,
        pixelDiffThreshold: 0,
      },
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps));
  assert.equal(probe.captureCalls, 2);
});

test("assert.visualDifference requires a real change and rejects identical frames", async () => {
  const changed = await new AcceptanceRunner(new FrameProbe([textured(), textured(true)])).run(
    manifest([
      { type: "capture.frame", id: "before" },
      { type: "assert.visualDifference", referenceCaptureId: "before" },
    ]),
  );
  assert.equal(changed.passed, true, JSON.stringify(changed.steps));

  const identical = await new AcceptanceRunner(new FrameProbe([textured(), textured()])).run(
    manifest([
      { type: "capture.frame", id: "before" },
      { type: "assert.visualDifference", referenceCaptureId: "before" },
    ]),
  );
  assert.equal(identical.passed, false);
  assert.match(
    failedStep(identical).error ?? failedStep(identical).message ?? "",
    /Expected visual difference .* perceptually identical/,
  );

  const missing = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "assert.visualDifference", referenceCaptureId: "x" }]),
  );
  assert.match(failedStep(missing).error ?? failedStep(missing).message ?? "", /Reference capture ID "x" not found/);

  const missingActual = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([
      { type: "capture.frame", id: "r" },
      { type: "assert.visualDifference", referenceCaptureId: "r", actualCaptureId: "y" },
    ]),
  );
  assert.match(
    failedStep(missingActual).error ?? failedStep(missingActual).message ?? "",
    /Actual capture ID "y" not found/,
  );
});

// ---- critique.visual ------------------------------------------------------

function provider(verdict: "pass" | "fail", throws = false) {
  const requests: Parameters<VisualCritiqueProvider["critique"]>[0][] = [];
  const p: VisualCritiqueProvider & { calls: number; requests: typeof requests } = {
    name: "stub",
    calls: 0,
    requests,
    async critique(input) {
      p.calls++;
      requests.push(input);
      if (throws) throw new Error("model offline");
      return {
        provider: "stub",
        verdict,
        findings:
          verdict === "fail"
            ? [{ code: "visual.playerMissing", severity: "error" as const, message: "player is invisible" }]
            : [],
      };
    },
  };
  return p;
}

test("critique.visual is skipped without a provider unless the manifest requires one", async () => {
  const skipped = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "critique.visual", rubric: "looks right" }]),
  );
  assert.equal(skipped.passed, true);
  assert.match(skipped.steps[0]?.message ?? "", /skipped/);

  const required = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "critique.visual", rubric: "looks right", requireProvider: true }]),
  );
  assert.equal(required.passed, false);
  assert.match(failedStep(required).error ?? failedStep(required).message ?? "", /visual\.providerUnavailable/);
});

test("critique.visual surfaces provider errors and failing verdicts with structured codes", async () => {
  const boom = await new AcceptanceRunner(new FrameProbe([textured()]), {
    critiqueProvider: provider("pass", true),
  }).run(manifest([{ type: "critique.visual", rubric: "r" }]));
  assert.equal(boom.passed, false);
  assert.match(failedStep(boom).error ?? failedStep(boom).message ?? "", /visual\.providerError: model offline/);

  const failing = await new AcceptanceRunner(new FrameProbe([textured()]), {
    critiqueProvider: provider("fail"),
  }).run(manifest([{ type: "critique.visual", rubric: "r" }]));
  assert.equal(failing.passed, false);
  assert.match(
    failedStep(failing).error ?? failedStep(failing).message ?? "",
    /visual\.critiqueFailed: player is invisible/,
  );

  const unknown = await new AcceptanceRunner(new FrameProbe([textured()]), {
    critiqueProvider: provider("pass"),
  }).run(manifest([{ type: "critique.visual", rubric: "r", captureId: "nope" }]));
  assert.match(failedStep(unknown).error ?? failedStep(unknown).message ?? "", /Capture ID "nope" not found/);
});

test("critique.visual passes the capture, rubric and runtime state to the provider", async () => {
  const p = provider("pass");
  const report = await new AcceptanceRunner(new FrameProbe([textured()]), { critiqueProvider: p }).run(
    manifest([
      { type: "capture.frame", id: "hud" },
      { type: "critique.visual", captureId: "hud", rubric: "HUD readable", expectedVisualFacts: ["score shown"] },
      { type: "critique.visual", rubric: "live frame" },
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps));
  assert.equal(p.calls, 2);
  assert.equal(report.steps[1]?.critiqueReport?.verdict, "pass");
  assert.equal(p.requests[0]?.captureId, "hud");
  assert.equal(p.requests[0]?.rubric, "HUD readable");
  assert.deepEqual(p.requests[0]?.expectedVisualFacts, ["score shown"]);
  assert.deepEqual(p.requests[0]?.runtimeState, { score: 3 });
  assert.equal(p.requests[0]?.recentLogs?.[0]?.message, "ok");
  assert.equal(p.requests[1]?.captureId, "current");
  assert.equal(p.requests[1]?.expectedVisualFacts, undefined);
});

// ---- performance ----------------------------------------------------------

test("performance.sample forwards only the options it was given and records the evidence", async () => {
  const probe = new PerfProbe([textured()], PERF);
  const report = await new AcceptanceRunner(probe).run(
    manifest([{ type: "performance.sample", warmupFrames: 0, sampleFrames: 5, mode: "continuous" }]),
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps));
  assert.deepEqual(probe.lastSampleOptions, { warmupFrames: 0, sampleFrames: 5, mode: "continuous" });
  assert.match(report.steps[0]?.message ?? "", /Sampled 60 frames \(stepped\)/);
  assert.equal(report.steps[0]?.performanceEvidence?.renderer.drawCalls, 20);
});

test("performance.sample fails on a probe that cannot sample", async () => {
  const report = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "performance.sample" }]),
  );
  assert.equal(report.passed, false);
  assert.match(failedStep(report).error ?? failedStep(report).message ?? "", /does not support samplePerformance/);
});

test("assert.performanceBudget reuses the last sample, samples on demand, and reports every violation", async () => {
  const probe = new PerfProbe([textured()], PERF);
  const pass = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "performance.sample" },
      { type: "assert.performanceBudget", budgets: { "renderer.drawCalls": { max: 100 } } },
    ]),
  );
  assert.equal(pass.passed, true, JSON.stringify(pass.steps));
  assert.equal(probe.samples, 1, "the budget step must reuse the sampled evidence");

  const onDemand = new PerfProbe([textured()], PERF);
  const sampled = await new AcceptanceRunner(onDemand).run(
    manifest([{ type: "assert.performanceBudget", budgets: { "frame.p95Ms": { max: 100 } } }]),
  );
  assert.equal(sampled.passed, true, JSON.stringify(sampled.steps));
  assert.equal(onDemand.samples, 1);

  const over = await new AcceptanceRunner(new PerfProbe([textured()], PERF)).run(
    manifest([
      {
        type: "assert.performanceBudget",
        budgets: { "renderer.drawCalls": { max: 10 }, "frame.p95Ms": { max: 1 }, "scene.objectCount": { max: 99 } },
      },
    ]),
  );
  assert.equal(over.passed, false);
  const step = failedStep(over);
  assert.match(step.error ?? step.message ?? "", /performance\.budgetExceeded/);
  assert.match(step.error ?? step.message ?? "", /renderer\.drawCalls/);
  assert.match(step.error ?? step.message ?? "", /frame\.p95Ms/);
  assert.doesNotMatch(step.error ?? step.message ?? "", /scene\.objectCount/);
});

test("assert.performanceBudget fails when there is no evidence and the probe cannot sample", async () => {
  const report = await new AcceptanceRunner(new FrameProbe([textured()])).run(
    manifest([{ type: "assert.performanceBudget", budgets: { "frame.p95Ms": { max: 100 } } }]),
  );
  assert.equal(report.passed, false);
  assert.match(failedStep(report).error ?? failedStep(report).message ?? "", /No performance evidence/);
});
