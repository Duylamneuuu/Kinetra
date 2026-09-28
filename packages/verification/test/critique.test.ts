import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AcceptanceRunner,
  encodePng,
  FakeVisualCritiqueProvider,
  type AcceptanceManifest,
  type RuntimeProbe,
} from "../src/index.js";

function createTestPng(r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width: 16, height: 16, data });
}

class MockRuntimeProbe implements RuntimeProbe {
  framePng = createTestPng(120, 180, 240);

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async input(): Promise<void> {}
  async wait(): Promise<void> {}
  async snapshot(): Promise<{ running: boolean; state: Record<string, unknown> }> {
    return { running: true, state: { player: { health: 100 } } };
  }
  async logs(): Promise<Array<{ level: "info" | "warning" | "error"; message: string }>> {
    return [{ level: "info", message: "Game booted successfully" }];
  }
  async captureFrame(): Promise<Uint8Array> {
    return this.framePng;
  }
  async metrics(): Promise<Record<string, number>> {
    return { fps: 60 };
  }
}

test("AcceptanceRunner integrates with FakeVisualCritiqueProvider", async () => {
  const probe = new MockRuntimeProbe();
  const provider = new FakeVisualCritiqueProvider();
  const runner = new AcceptanceRunner(probe, { critiqueProvider: provider });

  const manifest: AcceptanceManifest = {
    schemaVersion: 1,
    suite: "test-critique",
    seed: 0,
    target: "runtime",
    steps: [
      { type: "capture.frame", id: "baseline" },
      {
        type: "critique.visual",
        captureId: "baseline",
        rubric: "Check for adequate exposure and HUD elements",
        expectedVisualFacts: ["Player is visible", "Skybox is rendered"],
      },
    ],
  };

  const report = await runner.run(manifest);
  assert.equal(report.passed, true);
  assert.equal(report.steps.length, 2);

  const critiqueStep = report.steps[1]!;
  assert.equal(critiqueStep.passed, true);
  assert.ok(critiqueStep.critiqueReport);
  assert.equal(critiqueStep.critiqueReport.provider, "fake-critique-provider");
  assert.equal(critiqueStep.critiqueReport.verdict, "pass");
  assert.equal(provider.recordedRequests.length, 1);
  assert.equal(provider.recordedRequests[0]?.captureId, "baseline");
  assert.equal(provider.recordedRequests[0]?.expectedVisualFacts?.length, 2);
});

test("critique.visual fails with structured error when provider is required but absent", async () => {
  const probe = new MockRuntimeProbe();
  // Runner without critiqueProvider
  const runner = new AcceptanceRunner(probe);

  const manifest: AcceptanceManifest = {
    schemaVersion: 1,
    suite: "test-missing-provider",
    seed: 0,
    target: "runtime",
    steps: [
      {
        type: "critique.visual",
        rubric: "Check contrast",
        requireProvider: true,
      },
    ],
  };

  const report = await runner.run(manifest);
  assert.equal(report.passed, false);
  assert.equal(report.failedSteps?.length, 1);
  const failed = report.failedSteps[0]!;
  assert.ok(failed.error?.includes("visual.providerUnavailable"));
});

test("critique.visual handles provider errors without crashing runner", async () => {
  const probe = new MockRuntimeProbe();
  const provider = new FakeVisualCritiqueProvider();
  provider.shouldFail = true;
  const runner = new AcceptanceRunner(probe, { critiqueProvider: provider });

  const manifest: AcceptanceManifest = {
    schemaVersion: 1,
    suite: "test-provider-error",
    seed: 0,
    target: "runtime",
    steps: [
      {
        type: "critique.visual",
        rubric: "Inspect visuals",
      },
    ],
  };

  const report = await runner.run(manifest);
  assert.equal(report.passed, false);
  assert.equal(report.failedSteps?.length, 1);
  assert.ok(report.failedSteps[0]?.error?.includes("visual.providerError"));
});

test("capture.frame with saveArtifact writes artifact and protects against path traversal", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-visual-artifacts-"));
  try {
    const probe = new MockRuntimeProbe();
    const runner = new AcceptanceRunner(probe, { artifactDir: tempDir });

    const manifest: AcceptanceManifest = {
      schemaVersion: 1,
      suite: "test-artifact-persistence",
      seed: 0,
      target: "runtime",
      steps: [
        // Path traversal attempt in capture ID
        { type: "capture.frame", id: "../../../escaped_capture", saveArtifact: true },
        { type: "capture.frame", id: "healthy_frame", saveArtifact: true },
      ],
    };

    const report = await runner.run(manifest);
    assert.equal(report.passed, true);

    // Verify sanitized artifact filenames were created under tempDir
    const escapedBytes = await readFile(join(tempDir, "_________escaped_capture.png"));
    assert.ok(escapedBytes.byteLength > 0);

    const healthyBytes = await readFile(join(tempDir, "healthy_frame.png"));
    assert.ok(healthyBytes.byteLength > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
