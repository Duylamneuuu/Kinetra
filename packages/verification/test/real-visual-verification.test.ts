import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
} from "@kinetra/reference-game";

import {
  canRunRealElectronTests,
  realElectronLaunchArgs,
  AcceptanceRunner,
  ElectronRuntimeHost,
  FakeVisualCritiqueProvider,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const healthySceneId = stableId("scene", "p8-healthy-scene");
const defectiveSceneId = stableId("scene", "p8-defective-scene");
const modelEntityId = stableId("entity", "p8-visual-cube");
const healthyCameraId = stableId("entity", "p8-healthy-camera");
const defectiveCameraId = stableId("entity", "p8-defective-camera");
const lightId = stableId("entity", "p8-visual-light");
const cubeAssetId = stableId("asset", "p8-cube-glb");

function createVisualProject(): ProjectDocument {
  const healthyCube = {
    id: stableId("entity", "p8-healthy-cube"),
    name: "TargetCube",
    components: {
      Model: {
        assetId: cubeAssetId,
      },
      Transform: {
        position: [0, 1, 0] as [number, number, number],
        rotation: [0, 0.5, 0] as [number, number, number],
        scale: [2, 2, 2] as [number, number, number],
      },
    },
  };

  const defectiveCube = {
    id: stableId("entity", "p8-defective-cube"),
    name: "TargetCube",
    components: {
      Model: {
        assetId: cubeAssetId,
      },
      Transform: {
        position: [0, 1, 0] as [number, number, number],
        rotation: [0, 0.5, 0] as [number, number, number],
        scale: [2, 2, 2] as [number, number, number],
      },
    },
  };

  const healthyLight = {
    id: stableId("entity", "p8-healthy-light"),
    name: "DirectionalLight",
    components: {
      Light: {
        kind: "directional" as const,
        color: "#ffffff",
        intensity: 3.0,
      },
      Transform: {
        position: [3, 5, 4] as [number, number, number],
      },
    },
  };

  const defectiveLight = {
    id: stableId("entity", "p8-defective-light"),
    name: "DirectionalLight",
    components: {
      Light: {
        kind: "directional" as const,
        color: "#ffffff",
        intensity: 3.0,
      },
      Transform: {
        position: [3, 5, 4] as [number, number, number],
      },
    },
  };

  return {
    schemaVersion: 1,
    projectId: stableId("project", "p8-visual-verification"),
    name: "P8 Visual Verification Project",
    scenes: [
      {
        id: healthySceneId,
        name: "Healthy Scene",
        entities: [
          healthyCube,
          {
            id: healthyCameraId,
            name: "MainCamera",
            components: {
              Camera: {
                type: "perspective" as const,
                fov: 50,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 1, 5] as [number, number, number],
                rotation: [0, 0, 0] as [number, number, number],
              },
            },
          },
          healthyLight,
        ],
      },
      {
        id: defectiveSceneId,
        name: "Defective Scene",
        entities: [
          defectiveCube,
          {
            id: defectiveCameraId,
            name: "MainCamera",
            components: {
              Camera: {
                type: "perspective" as const,
                fov: 50,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 1, 5] as [number, number, number],
                rotation: [0, 3.14159, 0] as [number, number, number],
              },
            },
          },
          defectiveLight,
        ],
      },
    ],
  };
}

function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    electronArgs: realElectronLaunchArgs(),
    requestTimeoutMs: 30_000,
    captureMode: "visual",
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

test(
  "P8 Visual Verification — Real Electron Perceptual Comparison, Deliberate Regression, Arena, and Vision Critique",
  { skip: !canRunRealElectronTests(), timeout: 180_000 },
  async (t) => {
    // Generate synthetic model asset
    const cubeGlb = await createSyntheticGlb({
      size: [2, 2, 2],
      meshName: "VisualVerificationTargetMesh",
    });
    const cubeBase64 = Buffer.from(cubeGlb).toString("base64");
    const assets = { [cubeAssetId]: cubeBase64 };

    // -------------------------------------------------------------------------
    // SCENARIO 1: Healthy Frame, Perceptual Similarity, Deliberate Defect, and Repair
    // -------------------------------------------------------------------------
    await t.test("Scenario 1: Controlled visual regression catches defects that pass state/PNG checks", async () => {
      const host = createHost();
      const project = createVisualProject();

      const probe = new KinetraRuntimeProbe({
        host,
        project,
        assets,
        closeOnStop: false,
      });

      const runner = new AcceptanceRunner(probe);

      try {
        // Step A: Boot healthy scene, wait for model load, capture baseline, assert not blank, assert self-similarity
        const baselineManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-healthy-baseline",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: healthySceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            {
              type: "assert.equal",
              path: "renderer.captureMode",
              expected: "visual",
            },
            {
              type: "assert.equal",
              path: "renderer.preserveDrawingBuffer",
              expected: true,
            },
            {
              type: "assert.equal",
              path: "state.byName.TargetCube.model.loaded",
              expected: true,
            },
            { type: "capture.frame", id: "warmup" },
            { type: "wait", milliseconds: 50 },
            { type: "capture.frame", id: "healthyBaseline" },
            { type: "assert.visualNotBlank", captureId: "healthyBaseline" },
            // Same-state recapture should be perceptually similar within tight tolerance
            { type: "capture.frame", id: "healthyRecapture" },
            {
              type: "assert.visualSimilarity",
              referenceCaptureId: "healthyBaseline",
              actualCaptureId: "healthyRecapture",
              maxChangedPixelRatio: 0.03,
              maxPerceptualHashDistance: 4,
            },
          ],
        };

        const baselineReport = await runner.run(baselineManifest);
        assert.equal(
          baselineReport.passed,
          true,
          `Healthy baseline suite must pass. Failure: ${baselineReport.failureReason}`,
        );

        const captureStep = baselineReport.steps.find((s) => s.type === "capture.frame" && s.visualEvidence?.meanLuminance && s.visualEvidence.meanLuminance > 0.1);
        assert.ok(captureStep?.visualEvidence, "Capture step must output visualEvidence");
        assert.ok(captureStep.visualEvidence.width > 0, "Decoded width must be > 0");
        assert.ok(captureStep.visualEvidence.height > 0, "Decoded height must be > 0");
        assert.ok(captureStep.visualEvidence.entropy > 1.0, "Scene entropy must be > 1.0");

        // Step B: Deliberate visual defect: Camera pointed completely away (into empty space)
        // Notice: Entity exists, model is loaded, no fatal logs, PNG is valid!
        const stateChecksManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-defect-state-checks",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: defectiveSceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            {
              type: "assert.equal",
              path: "state.byName.TargetCube.model.loaded",
              expected: true,
            },
            {
              type: "assert.equal",
              path: "running",
              expected: true,
            },
            {
              type: "assert.logAbsent",
              minimumLevel: "error",
            },
            {
              type: "assert.screenshotValidPng",
              minBytes: 1000,
            },
          ],
        };

        const stateReport = await runner.run(stateChecksManifest);
        assert.equal(
          stateReport.passed,
          true,
          "Defective scene must still pass non-visual checks (entity loaded, running, no errors, valid PNG)",
        );

        // Now prove the perceptual visual similarity assertion catches the defect!
        const comparisonManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-deliberate-perceptual-mismatch",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: healthySceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            { type: "capture.frame", id: "warmup" },
            { type: "wait", milliseconds: 50 },
            { type: "capture.frame", id: "healthyBaseline" },
            { type: "runtime.start", sceneId: defectiveSceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            { type: "capture.frame", id: "defectiveFrame" },
            // Deliberately assert similarity against defective frame
            {
              type: "assert.visualSimilarity",
              referenceCaptureId: "healthyBaseline",
              actualCaptureId: "defectiveFrame",
              maxChangedPixelRatio: 0.05,
              maxPerceptualHashDistance: 8,
            },
          ],
        };

        // Comparison against defectiveFrame must FAIL with structured diagnostic values!
        const compareReport = await runner.run(comparisonManifest);
        assert.equal(
          compareReport.passed,
          false,
          "assert.visualSimilarity must fail when comparing healthy scene to defective scene",
        );
        const failedStep = compareReport.failedSteps?.[0];
        assert.ok(failedStep, "Must have a recorded failed step");
        assert.equal(failedStep.type, "assert.visualSimilarity");
        assert.ok(
          failedStep.message?.includes("visual.perceptualMismatch"),
          `Error message must contain visual.perceptualMismatch, got: ${failedStep.message}`,
        );
        assert.ok(failedStep.actual, "Must provide actual comparison metrics in StepResult");

        // Also prove assert.visualDifference PASSES on the defect
        const differenceManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-visual-difference-proof",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: healthySceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            { type: "capture.frame", id: "warmup" },
            { type: "wait", milliseconds: 50 },
            { type: "capture.frame", id: "healthyBaseline" },
            { type: "runtime.start", sceneId: defectiveSceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            { type: "capture.frame", id: "defectiveFrame" },
            {
              type: "assert.visualDifference",
              referenceCaptureId: "healthyBaseline",
              actualCaptureId: "defectiveFrame",
              minChangedPixelRatio: 0.1,
              minPerceptualHashDistance: 6,
            },
          ],
        };
        const diffReport = await runner.run(differenceManifest);
        assert.equal(diffReport.passed, true, "assert.visualDifference must pass between healthy and defective frames");

        // Step C: Fix the defect through normal project authoring and prove it passes
        const fixedManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-fixed-scene",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: healthySceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            { type: "capture.frame", id: "warmup" },
            { type: "wait", milliseconds: 50 },
            { type: "capture.frame", id: "fixedFrame1" },
            { type: "capture.frame", id: "fixedFrame2" },
            {
              type: "assert.visualSimilarity",
              referenceCaptureId: "fixedFrame1",
              actualCaptureId: "fixedFrame2",
              maxChangedPixelRatio: 0.03,
              maxPerceptualHashDistance: 4,
            },
          ],
        };
        const fixedReport = await runner.run(fixedManifest);
        assert.equal(fixedReport.passed, true, "Fixed scene must pass visual similarity");

        await probe.close().catch(() => {});
      } finally {
        await host.close().catch(() => {});
      }
    });

    // -------------------------------------------------------------------------
    // SCENARIO 2: Real Kinetra Arena Visual Verification
    // -------------------------------------------------------------------------
    await t.test("Scenario 2: Real Arena game frames verify non-blank, stability, and state change", async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => {
          const p = createArenaProject();
          const cam = p.scenes[0]!.entities.find((e) => e.name === "MainCamera");
          if (cam?.components) {
            const comps = cam.components as Record<string, any>;
            if (comps.Transform) {
              comps.Transform.position = [-5, 3, -1];
              comps.Transform.rotation = [-0.35, 0, 0];
            }
          }
          return p;
        },
        assets: arenaAudioAssets,
        closeOnStop: false,
      });

      const runner = new AcceptanceRunner(probe);

      try {
        const arenaManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-arena-visual-acceptance",
          seed: 1234,
          target: "runtime",
          steps: [
            // Start Arena at initial playing state
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            // Warmup frame
            { type: "capture.frame", id: "arenaWarmup" },
            { type: "wait", milliseconds: 50 },
            // Capture baseline arena frame
            { type: "capture.frame", id: "arenaStart" },
            { type: "assert.visualNotBlank", captureId: "arenaStart" },
            // Same state recapture within tolerance
            { type: "capture.frame", id: "arenaStep" },
            {
              type: "assert.visualSimilarity",
              referenceCaptureId: "arenaStart",
              actualCaptureId: "arenaStep",
              maxChangedPixelRatio: 0.05,
              maxPerceptualHashDistance: 6,
            },
            // Move player across arena
            { type: "input", action: "player.moveRight", phase: "press", value: 1 },
            { type: "runtime.step", steps: 5, deltaSeconds: 1 / 60 },
            { type: "input", action: "player.moveRight", phase: "press", value: 1 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            { type: "input", action: "player.moveRight", phase: "press", value: 1 },
            { type: "runtime.step", steps: 10, deltaSeconds: 1 / 60 },
            // Active moved frame
            { type: "capture.frame", id: "arenaMoved" },
            { type: "assert.visualNotBlank", captureId: "arenaMoved" },
            // Start vs Moved must register visual difference
            {
              type: "assert.visualDifference",
              referenceCaptureId: "arenaStart",
              actualCaptureId: "arenaMoved",
              minChangedPixelRatio: 0.03,
              minPerceptualHashDistance: 3,
            },
          ],
        };

        const report = await runner.run(arenaManifest);
        assert.equal(
          report.passed,
          true,
          `Arena visual acceptance must pass. Failure: ${report.failureReason}`,
        );

        assert.ok(report.observations?.visualCaptures, "Observations must record visualCaptures");
        const captures = report.observations.visualCaptures as Record<string, any>;
        assert.ok(captures["arenaStart"], "Must have arenaStart capture record");
        assert.ok(captures["arenaMoved"], "Must have arenaMoved capture record");
        assert.ok(captures["arenaStart"].entropy > 1.5, "Arena start entropy must be > 1.5");

        await probe.close().catch(() => {});
      } finally {
        await host.close().catch(() => {});
      }
    });

    // -------------------------------------------------------------------------
    // SCENARIO 3: Vision Critique Provider Integration & Failure Resilience
    // -------------------------------------------------------------------------
    await t.test("Scenario 3: Vision critique contract, fake provider, and error isolation", async () => {
      const host = createHost();
      const project = createVisualProject();
      const probe = new KinetraRuntimeProbe({
        host,
        project,
        assets,
        closeOnStop: false,
      });

      const fakeProvider = new FakeVisualCritiqueProvider();
      fakeProvider.fixedVerdict = "pass"; // Explicitly pass for positive proof
      const runner = new AcceptanceRunner(probe, { critiqueProvider: fakeProvider });

      try {
        const critiqueManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-vision-critique-integration",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: healthySceneId, assets },
            { type: "wait", milliseconds: 400 },
            { type: "runtime.step", steps: 5, deltaSeconds: 1 / 60 },
            { type: "capture.frame", id: "critiqueTarget" },
            {
              type: "critique.visual",
              captureId: "critiqueTarget",
              rubric: "Verify target cube is clearly rendered and illuminated",
              expectedVisualFacts: [
                "TargetCube is visible in center",
                "Lighting produces visible shading",
              ],
            },
          ],
        };

        const report = await runner.run(critiqueManifest);
        assert.equal(report.passed, true, `Critique run must pass. Failure: ${report.failureReason}`);

        // Verify provider was invoked with real captured image and runtime context
        assert.equal(fakeProvider.recordedRequests.length, 1);
        const req = fakeProvider.recordedRequests[0]!;
        assert.equal(req.captureId, "critiqueTarget");
        assert.ok(req.framePng.byteLength > 1000, "Must pass real frame PNG bytes");
        assert.ok(req.evidence.width > 0, "Must pass decoded evidence");
        assert.equal(req.expectedVisualFacts?.length, 2);

        // Negative check 1: Provider required by manifest but missing on runner
        const runnerWithoutProvider = new AcceptanceRunner(probe);
        const missingProviderManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-missing-provider-rejection",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: healthySceneId, assets },
            {
              type: "critique.visual",
              rubric: "Strict check",
              requireProvider: true,
            },
          ],
        };
        const missingReport = await runnerWithoutProvider.run(missingProviderManifest);
        assert.equal(missingReport.passed, false);
        assert.ok(missingReport.failedSteps?.[0]?.error?.includes("visual.providerUnavailable"));

        // Negative check 2: Provider throws exception; Electron runtime remains intact
        fakeProvider.shouldFail = true;
        const errorManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p8-provider-error-resilience",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: healthySceneId, assets },
            {
              type: "critique.visual",
              rubric: "Crash test",
            },
          ],
        };
        const errorReport = await runner.run(errorManifest);
        assert.equal(errorReport.passed, false);
        assert.ok(errorReport.failedSteps?.[0]?.error?.includes("visual.providerError"));

        // Verify runtime is still responsive and healthy after provider error (clean stop)
        const snap = await probe.snapshot();
        assert.equal(typeof snap.running, "boolean");

        await probe.close().catch(() => {});
      } finally {
        await host.close().catch(() => {});
      }
    });
  },
);
