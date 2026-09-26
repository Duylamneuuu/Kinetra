import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectGlb,
  validateAssetRecord,
  type AssetRecord,
} from "@kinetra/asset-pipeline";
import {
  assertValidProject,
  stableId,
  type ProjectDocument,
} from "@kinetra/project-model";
import {
  AcceptanceRunner,
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
  type AcceptanceManifest,
} from "../src/index.js";

function findReferenceGameProp(relPath: string): string {
  let curr = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(curr, relPath);
    if (existsSync(candidate)) return candidate;
    curr = dirname(curr);
  }
  return resolve(process.cwd(), relPath);
}

const propGlbPath = findReferenceGameProp("examples/reference-game/assets/props/energy-crate.glb");
const propAssetJsonPath = findReferenceGameProp("examples/reference-game/assets/props/energy-crate.asset.json");

const sceneId = stableId("scene", "scenario-asset-acceptance");
const propEntityId = stableId("entity", "scenario-energy-crate");
const cameraId = stableId("entity", "scenario-camera");
const lightId = stableId("entity", "scenario-light");
const propAssetId = "asset_prop_energy_crate";
const unresolvableAssetId = "asset_prop_unresolvable";

function scenarioPropFixtureProject(targetAssetId: string = propAssetId): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "scenario-asset-acceptance"),
    name: "Scenario Asset Acceptance Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Scenario Prop Scene",
        entities: [
          {
            id: propEntityId,
            name: "EnergyCrate",
            components: {
              Model: {
                assetId: targetAssetId,
              },
              Transform: {
                position: [0, 0.5, 0],
                rotation: [0, 0.3, 0],
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
                position: [0, 1.8, 3.5],
                rotation: [-0.3, 0, 0],
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
                intensity: 3.0,
              },
              Transform: {
                position: [3, 4, 3],
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
    electronArgs: realElectronLaunchArgs(),
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

test("Scenario prop fixture passes asset pipeline inspection, validation, and provenance checks", async () => {
  const glbBytes = await readFile(propGlbPath);
  assert.ok(glbBytes.byteLength > 100, "GLB file must not be empty");

  // Verify binary GLB header structure (glTF 2.0 binary)
  const header = inspectGlb(glbBytes);
  assert.equal(header.magic, 0x46546c67, "Magic must match glTF binary signature");
  assert.equal(header.version, 2, "GLB version must be 2");
  assert.equal(header.length, glbBytes.byteLength, "Header declared length must match actual byte length");

  // Read and parse asset record
  const assetJsonText = await readFile(propAssetJsonPath, "utf8");
  const assetRecord = JSON.parse(assetJsonText) as AssetRecord;

  assert.equal(assetRecord.id, propAssetId);
  assert.equal(assetRecord.kind, "model");

  // Verify content hash matches bytes
  const computedHash = createHash("sha256").update(glbBytes).digest("hex");
  assert.equal(assetRecord.source.contentHash, computedHash);

  // Verify provenance metadata exists and truthfully identifies Kinetra synthetic prop generator
  const provenance = assetRecord.metadata.provenance;
  assert.ok(provenance, "Provenance metadata must be present");
  assert.equal(provenance.provider, "kinetra");
  assert.equal(provenance.generator, "createSyntheticPropGlb");
  assert.equal(provenance.license, "MIT");
  assert.equal(provenance.model, undefined);
  assert.equal(provenance.sourceAssetId, undefined);
  assert.equal(provenance.creativeUnitsCost, undefined);
  assert.notEqual(provenance.provider, "scenario");

  // Validate through asset pipeline policy
  const diagnostics = validateAssetRecord(assetRecord);
  const errors = diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(errors, [], `Asset record validation produced errors: ${JSON.stringify(errors)}`);
});

test("Command bus authors prop entity into project document adhering to schema validation", () => {
  const project = scenarioPropFixtureProject(propAssetId);
  assertValidProject(project);

  const scene = project.scenes.find((s) => s.id === sceneId);
  assert.ok(scene);

  const crate = scene.entities.find((e) => e.name === "EnergyCrate");
  assert.ok(crate);
  assert.equal(crate.components.Model && (crate.components.Model as { assetId?: string }).assetId, propAssetId);
  assert.deepEqual(crate.components.Transform, {
    position: [0, 0.5, 0],
    rotation: [0, 0.3, 0],
    scale: [1, 1, 1],
  });
});

test(
  "Real Electron runtime loads Scenario prop GLB via AssetResolver, verifies structured state, and captures valid PNG",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const glbBytes = await readFile(propGlbPath);
    const glbBase64 = Buffer.from(glbBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => scenarioPropFixtureProject(propAssetId),
      initialRevision: 1,
      closeOnStop: false,
      assets: {
        [propAssetId]: glbBase64,
      },
    });

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "scenario-asset-acceptance",
        seed: 42,
        target: "runtime",
        steps: [
          // Boot Electron player runtime with scene referencing assetId
          { type: "runtime.start", sceneId },
          { type: "assert.equal", path: "running", expected: true },

          // Assert model load state via Kinetra-owned structured query
          {
            type: "assert.equal",
            path: "state.byName.EnergyCrate.model.loaded",
            expected: true,
          },
          {
            type: "assert.equal",
            path: "state.byName.EnergyCrate.model.assetId",
            expected: propAssetId,
          },
          // 2 distinct meshes: frame and core
          {
            type: "assert.equal",
            path: "state.byName.EnergyCrate.model.meshCount",
            expected: 2,
          },
          // Assert expected bounds size [0.8, 0.8, 0.8] from frame geometry
          {
            type: "assert.near",
            path: "state.byName.EnergyCrate.model.bounds.size.0",
            expected: 0.8,
            tolerance: 0.01,
          },
          {
            type: "assert.near",
            path: "state.byName.EnergyCrate.model.bounds.size.1",
            expected: 0.8,
            tolerance: 0.01,
          },
          {
            type: "assert.near",
            path: "state.byName.EnergyCrate.model.bounds.size.2",
            expected: 0.8,
            tolerance: 0.01,
          },
          // Assert entity transform applied
          {
            type: "assert.equal",
            path: "state.byName.EnergyCrate.position",
            expected: [0, 0.5, 0],
          },

          // Capture valid PNG proving prop renders visibly with camera and light
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
  "Deliberate failure: unresolvable prop assetId produces structured error state and log evidence without crashing Electron",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => scenarioPropFixtureProject(unresolvableAssetId),
      initialRevision: 1,
      closeOnStop: false,
      assets: {}, // Empty assets map so assetId fails to resolve
    });

    try {
      await probe.start(sceneId, 1);

      const snapshot = await probe.snapshot();
      const entity = (snapshot.state as any).byName?.EnergyCrate;
      assert.ok(entity, "EnergyCrate entity must exist in snapshot");
      assert.equal(entity.model?.loaded, false, "Model must not be marked as loaded");
      assert.equal(entity.model?.assetId, unresolvableAssetId);
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
      assert.equal(failedLog.data?.assetId, unresolvableAssetId);

      await probe.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "Clean teardown leaves zero orphan Electron processes after scenario asset test",
  { skip: !canRunRealElectronTests(), timeout: 30_000 },
  async () => {
    const glbBytes = await readFile(propGlbPath);
    const glbBase64 = Buffer.from(glbBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => scenarioPropFixtureProject(propAssetId),
      initialRevision: 1,
      closeOnStop: true,
      assets: {
        [propAssetId]: glbBase64,
      },
    });

    try {
      await probe.start(sceneId, 1);
      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);
      assert.equal((snapshot.state as any).byName?.EnergyCrate?.model?.loaded, true);

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
