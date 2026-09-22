import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  canRunRealElectronTests,  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p4-real-model");
const modelEntityId = stableId("entity", "p4-model-box");
const cameraId = stableId("entity", "p4-model-camera");
const lightId = stableId("entity", "p4-model-light");
const testAssetId = stableId("asset", "p4-test-box-glb");
const missingAssetId = stableId("asset", "p4-nonexistent-glb");

function modelFixtureProject(targetAssetId: string = testAssetId): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p4-real-model"),
    name: "P4 Real Model Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Model Acceptance Scene",
        entities: [
          {
            id: modelEntityId,
            name: "ModelBox",
            components: {
              Model: {
                assetId: targetAssetId,
              },
              Transform: {
                position: [0, 1, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
            },
          },
          {
            id: cameraId,
            name: "MainCamera",
            components: {
              Camera: {
                type: "perspective",
                fov: 50,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 2, 5],
                rotation: [-0.2, 0, 0],
              },
            },
          },
          {
            id: lightId,
            name: "KeyLight",
            components: {
              Light: {
                kind: "directional",
                color: "#ffffff",
                intensity: 2.5,
              },
              Transform: {
                position: [3, 5, 4],
              },
            },
          },
        ],
      },
    ],
  };
}

function createTestHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

test(
  "real Electron runtime loads GLB via Kinetra asset identity, resolves through AssetResolver, applies transform, renders in PNG, and passes AcceptanceRunner",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    // 1. Generate deterministic synthetic GLB with known 1x1x1 dimensions and material
    const glbBytes = await createSyntheticGlb({
      meshName: "TestBoxMesh",
      nodeName: "TestBoxNode",
      materialName: "CyanBoxMaterial",
      size: [1, 1, 1],
      color: [0.0, 0.75, 0.85, 1.0],
    });
    const glbBase64 = Buffer.from(glbBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => modelFixtureProject(testAssetId),
      initialRevision: 1,
      closeOnStop: false,
      assets: {
        [testAssetId]: glbBase64,
      },
    });

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p4-real-glb-loading",
        seed: 42,
        target: "runtime",
        steps: [
          // Boot Electron player runtime with scene referencing assetId
          { type: "runtime.start", sceneId },
          { type: "assert.equal", path: "running", expected: true },

          // Assert model load state via Kinetra-owned structured query
          {
            type: "assert.equal",
            path: "state.byName.ModelBox.model.loaded",
            expected: true,
          },
          {
            type: "assert.equal",
            path: "state.byName.ModelBox.model.assetId",
            expected: testAssetId,
          },
          {
            type: "assert.equal",
            path: "state.byName.ModelBox.model.meshCount",
            expected: 1,
          },
          // Assert expected bounds from geometry
          {
            type: "assert.equal",
            path: "state.byName.ModelBox.model.bounds.size",
            expected: [1, 1, 1],
          },
          // Assert entity transform applied
          {
            type: "assert.equal",
            path: "state.byName.ModelBox.position",
            expected: [0, 1, 0],
          },

          // Capture valid PNG proving model renders visibly with camera and light
          { type: "assert.screenshotValidPng", minBytes: 1_000 },

          // Assert zero error logs
          { type: "assert.logAbsent", minimumLevel: "error" },

          // Clean stop
          { type: "runtime.stop" },
        ],
      };

      const runner = new AcceptanceRunner(probe);
      const report = await runner.run(manifest);

      assert.equal(
        report.passed,
        true,
        `Acceptance report failed: ${JSON.stringify(report.steps.filter((s) => !s.passed))}`,
      );
      assert.equal(report.steps.length, manifest.steps.length);
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "unresolvable assetId produces truthful structured failure state and error log evidence rather than silent success",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => modelFixtureProject(missingAssetId),
      initialRevision: 1,
      closeOnStop: false,
      // No assets provided so missingAssetId cannot be resolved
    });

    try {
      await probe.start(sceneId, 1);

      const snapshot = await probe.snapshot();
      const entity = (snapshot.state as any).byName?.ModelBox;
      assert.ok(entity, "ModelBox entity must exist in snapshot");
      assert.equal(entity.model?.loaded, false, "Model must not be marked as loaded");
      assert.equal(entity.model?.assetId, missingAssetId);
      assert.ok(
        typeof entity.model?.error === "string" && entity.model.error.length > 0,
        "Model must expose error description",
      );

      // Verify structured error log was recorded
      const logs = await probe.logs();
      const failedLog = logs.find(
        (l) => l.level === "error" && l.message === "model.loadFailed",
      );
      assert.ok(
        failedLog,
        "A structured 'model.loadFailed' error log must be recorded when asset is unresolvable",
      );
      assert.equal(failedLog.data?.assetId, missingAssetId);

      await probe.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "clean teardown releases model resources and leaves zero orphan Electron processes",
  { skip: !canRunRealElectronTests(), timeout: 30_000 },
  async () => {
    const glbBytes = await createSyntheticGlb({
      meshName: "BoxMesh",
      nodeName: "BoxNode",
      size: [1, 1, 1],
    });

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => modelFixtureProject(testAssetId),
      initialRevision: 1,
      closeOnStop: true,
      assets: {
        [testAssetId]: Buffer.from(glbBytes).toString("base64"),
      },
    });

    try {
      await probe.start(sceneId, 1);
      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);
      assert.equal((snapshot.state as any).byName?.ModelBox?.model?.loaded, true);

      // Stopping probe with closeOnStop cleans up host
      await probe.stop();

      // Repeated close calls are idempotent and safe
      await probe.close();
      await host.close();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);
