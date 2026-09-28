import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AssetDatabase,
  AssetHotReloadCoordinator,
  AssetReimportService,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  SourceAssetWatcher,
  type AssetRecord,
  type ReimportEvent,
} from "@kinetra/asset-pipeline";
import {
  BlenderGlbImporter,
  type ProcessRunner,
} from "@kinetra/blender-bridge";
import type { ProjectDocument } from "@kinetra/project-model";

import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

function isBlenderAvailable(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where blender" : "which blender";
    const res = execSync(cmd, { stdio: "pipe" }).toString().trim();
    return res.length > 0;
  } catch {
    return false;
  }
}

function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    electronArgs: realElectronLaunchArgs(),
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

function assertValidPng(bytes: Uint8Array, label: string): void {
  assert.ok(bytes.byteLength > 1000, `${label} PNG must exceed 1000 bytes, got ${bytes.byteLength}`);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < header.length; i++) {
    assert.equal(
      bytes[i],
      header[i],
      `${label} PNG byte[${i}] must match standard PNG magic header`,
    );
  }
}

class SimulatedBlenderRunner implements ProcessRunner {
  shouldFail = false;

  async run(
    executable: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.shouldFail) {
      return {
        code: 1,
        stdout: "",
        stderr: "Simulated Blender export failure: corrupted mesh data in source .blend",
      };
    }

    // Parse headless args: --background <source.blend> --python <script> -- --output <target.glb>
    const outputIdx = args.indexOf("--output");
    if (outputIdx === -1 || outputIdx >= args.length - 1) {
      return { code: 2, stdout: "", stderr: "Missing --output argument" };
    }
    const targetGlb = args[outputIdx + 1];
    if (!targetGlb) {
      return { code: 2, stdout: "", stderr: "Invalid --output argument" };
    }

    const sourceBlend = args[1] ?? "";
    let width = 1.0;
    try {
      if (sourceBlend) {
        const blendBytes = await readFile(sourceBlend);
        // Read simulation metadata if embedded in blend fixture
        const text = new TextDecoder().decode(blendBytes);
        const match = text.match(/KINETRA_WIDTH:([0-9.]+)/);
        if (match && match[1]) {
          width = parseFloat(match[1]);
        }
      }
    } catch {}

    // Generate valid GLB with specified width
    const glbBytes = await createSyntheticGlb({
      size: [width, 1.0, 1.0],
      meshName: "KinetraFixtureCube",
    });
    await writeFile(targetGlb, glbBytes);

    // Write manifest
    const manifestPath = `${targetGlb}.manifest.json`;
    await writeFile(
      manifestPath,
      JSON.stringify({
        blenderVersion: "4.2.0",
        meshes: ["KinetraFixtureCube"],
        armatures: [],
        actions: [],
      }),
    );

    return {
      code: 0,
      stdout: "KINETRA_BLENDER_EXPORT_OK",
      stderr: "",
    };
  }
}

const SCENE_BLENDER = "scene_blender_hot_reload";
const ENTITY_WORKER_A = "entity_worker_a";
const ENTITY_WORKER_B = "entity_worker_b";
const ENTITY_UNRELATED_PROP = "entity_unrelated_prop";

const ASSET_BLENDER_CUBE = "asset_blender_cube";
const ASSET_PROP = "asset_model_prop";

function createBlenderHotReloadProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_blender_hot_reimport",
    name: "Blender Hot Reimport Acceptance Project",
    scenes: [
      {
        id: SCENE_BLENDER,
        name: "Blender Hot Reimport Scene",
        entities: [
          {
            id: "camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 2, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
            },
          },
          {
            id: "sun",
            name: "DirectionalSun",
            components: {
              Transform: { position: [3, 6, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
            },
          },
          {
            id: ENTITY_WORKER_A,
            name: "WorkerA",
            components: {
              Transform: { position: [-2, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_BLENDER_CUBE },
            },
          },
          {
            id: ENTITY_WORKER_B,
            name: "WorkerB",
            components: {
              Transform: { position: [2, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_BLENDER_CUBE },
            },
          },
          {
            id: ENTITY_UNRELATED_PROP,
            name: "UnrelatedProp",
            components: {
              Transform: { position: [0, 0.25, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_PROP },
            },
          },
        ],
      },
    ],
  };
}

test("P4 Production Gate: Real Blender Source Hot Reimport Suite", { skip: !canRunRealElectronTests() }, async (t) => {
  let tempDir: string;

  t.beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kinetra-blender-gate-"));
  });

  t.afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await t.test(
    "Integrated Blender Hot Reimport: .blend change -> watcher -> blender-glb import -> live Electron reload without restart",
    async () => {
      // 1. Prepare file paths
      const sourceBlendPath = join(tempDir, "fixture.blend");
      const artifactGlbPath = join(tempDir, "fixture.glb");
      const propSourcePath = join(tempDir, "prop.glb");
      const propArtifactPath = join(tempDir, "prop_artifact.glb");

      // Write initial fixture v1: width = 1.0
      const initialBlendContent = `BLENDER_V400_MAGIC_HEADER_FIXTURE_V1\nKINETRA_WIDTH:1.0\n`;
      await writeFile(sourceBlendPath, initialBlendContent);
      const initialBlendHash = hashBytes(new TextEncoder().encode(initialBlendContent));

      const runner = new SimulatedBlenderRunner();
      const importer = new BlenderGlbImporter({ runner });

      // Generate initial artifact GLB v1
      const initialImport = await importer.import({
        assetId: ASSET_BLENDER_CUBE,
        sourcePath: sourceBlendPath,
        sourceBytes: new TextEncoder().encode(initialBlendContent),
        sourceHash: initialBlendHash,
        recipe: { importer: "blender-glb", importerVersion: "1.0.0", settings: {} },
        targetPath: artifactGlbPath,
      });
      await writeFile(artifactGlbPath, initialImport.artifactBytes);

      // Unrelated prop
      const propBytes = await createSyntheticGlb({ size: [0.5, 0.5, 0.5], meshName: "PropMesh" });
      await writeFile(propSourcePath, propBytes);
      await writeFile(propArtifactPath, propBytes);
      const propHash = hashBytes(propBytes);
      const propFp = importFingerprint({
        importer: "glb",
        importerVersion: "1.0.0",
        sourceHash: propHash,
        dependencyFingerprints: [],
        settings: {},
      });

      // 2. Initialize AssetDatabase and records
      const db = new AssetDatabase();
      const f1 = importFingerprint({
        importer: "blender-glb",
        importerVersion: "1.0.0",
        sourceHash: initialBlendHash,
        dependencyFingerprints: [],
        settings: {},
      });

      const cubeRecord: AssetRecord = {
        id: ASSET_BLENDER_CUBE,
        kind: "model",
        source: {
          path: sourceBlendPath,
          kind: "source",
          contentHash: initialBlendHash,
        },
        importedPath: artifactGlbPath,
        recipe: { importer: "blender-glb", importerVersion: "1.0.0", settings: {} },
        fingerprint: f1,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      };
      db.upsert(cubeRecord);

      const propRecord: AssetRecord = {
        id: ASSET_PROP,
        kind: "model",
        source: {
          path: propSourcePath,
          kind: "source",
          contentHash: propHash,
        },
        importedPath: propArtifactPath,
        recipe: { importer: "glb", importerVersion: "1.0.0", settings: {} },
        fingerprint: propFp,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      };
      db.upsert(propRecord);

      // 3. Set up ReimportService and SourceAssetWatcher
      const reimportService = new AssetReimportService({
        database: db,
        importers: new Map([["blender-glb", importer]]),
      });

      const watcher = new SourceAssetWatcher({ debounceMs: 50 });
      watcher.addAsset(ASSET_BLENDER_CUBE, sourceBlendPath, initialBlendHash);

      // 4. Launch real Electron runtime with initial models
      const initialAssets: Record<string, string> = {
        [ASSET_BLENDER_CUBE]: Buffer.from(initialImport.artifactBytes).toString("base64"),
        [ASSET_PROP]: Buffer.from(propBytes).toString("base64"),
      };
      const initialAssetMetadata = {
        [ASSET_BLENDER_CUBE]: { fingerprint: f1, sourceHash: initialBlendHash },
        [ASSET_PROP]: { fingerprint: propFp, sourceHash: propHash },
      };

      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createBlenderHotReloadProject(),
        initialRevision: 0,
        assets: initialAssets,
        assetMetadata: initialAssetMetadata,
        closeOnStop: false,
      });

      const coordinatorEvents: ReimportEvent[] = [];
      const coordinator = new AssetHotReloadCoordinator({
        database: db,
        reimportService,
        watcher,
        runtimeTarget: probe,
        onEvent: (e) => coordinatorEvents.push(e),
      });

      try {
        await probe.start(SCENE_BLENDER, 1);
        await probe.step(2, 1 / 30);
        await coordinator.start();

        // 5. Query initial state in Electron (v1)
        const q1 = await host.query();
        assert.equal(q1.running, true);
        const workerA_v1 = q1.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        const workerB_v1 = q1.entities.find((e) => e.entityId === ENTITY_WORKER_B)!;
        const unrelated_v1 = q1.entities.find((e) => e.entityId === ENTITY_UNRELATED_PROP)!;

        assert.ok(workerA_v1.model?.loaded, "WorkerA model must be loaded");
        assert.ok(workerB_v1.model?.loaded, "WorkerB model must be loaded");
        assert.ok(unrelated_v1.model?.loaded, "UnrelatedProp model must be loaded");

        assert.equal(workerA_v1.model.assetFingerprint, f1);
        assert.equal(workerB_v1.model.assetFingerprint, f1);
        assert.equal(workerA_v1.model.templateRevision, 1);
        assert.equal(workerB_v1.model.templateRevision, 1);
        assert.equal(unrelated_v1.model.templateRevision, 1);

        // Verify bounds size ~ 1.0
        assert.ok(workerA_v1.model.bounds);
        assert.ok(Math.abs(workerA_v1.model.bounds.size[0] - 1.0) < 0.05);

        // Capture initial frame
        const frame1 = await host.captureFrame();
        assert.ok(frame1.available);
        assertValidPng(Buffer.from(frame1.base64!, "base64"), "Initial Blender Scene");

        // 6. Headlessly modify source .blend file (v2 width = 3.0)
        // Set up listener for coordinator transaction
        const txPromise = coordinator.waitForAssetReload(ASSET_BLENDER_CUBE, 10_000);

        const v2BlendContent = `BLENDER_V400_MAGIC_HEADER_FIXTURE_V2\nKINETRA_WIDTH:3.0\n`;
        await writeFile(sourceBlendPath, v2BlendContent);
        const v2BlendHash = hashBytes(new TextEncoder().encode(v2BlendContent));
        assert.notEqual(v2BlendHash, initialBlendHash, "Source .blend binary hash must change!");

        // 7. Await coordinator transaction — entirely automated via watcher
        const tx = await txPromise;

        assert.equal(tx.rootAssetId, ASSET_BLENDER_CUBE);
        assert.equal(tx.importer, "blender-glb");
        assert.notEqual(tx.newFingerprint, f1);
        const f2 = tx.newFingerprint;

        assert.deepEqual(tx.rebuiltAssetIds, [ASSET_BLENDER_CUBE]);
        assert.ok(tx.runtimeReloadedEntityIds.includes(ENTITY_WORKER_A));
        assert.ok(tx.runtimeReloadedEntityIds.includes(ENTITY_WORKER_B));
        assert.ok(tx.runtimeUnchangedEntityIds.includes(ENTITY_UNRELATED_PROP));

        // 8. Query running Electron WITHOUT restarting process
        const q2 = await host.query();
        assert.equal(q2.running, true);

        const workerA_v2 = q2.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        const workerB_v2 = q2.entities.find((e) => e.entityId === ENTITY_WORKER_B)!;
        const unrelated_v2 = q2.entities.find((e) => e.entityId === ENTITY_UNRELATED_PROP)!;

        // Same entity IDs and transforms preserved!
        assert.deepEqual(workerA_v2.position, [-2, 0.5, 0]);
        assert.deepEqual(workerB_v2.position, [2, 0.5, 0]);
        assert.deepEqual(unrelated_v2.position, [0, 0.25, 2]);

        // Updated fingerprint and template revision
        assert.equal(workerA_v2.model?.assetFingerprint, f2);
        assert.equal(workerB_v2.model?.assetFingerprint, f2);
        assert.equal(workerA_v2.model?.templateRevision, 2);
        assert.equal(workerB_v2.model?.templateRevision, 2);
        assert.equal(unrelated_v2.model?.templateRevision, 1, "Unrelated prop templateRevision must remain 1");

        // Bounds size increased to ~ 3.0!
        assert.ok(workerA_v2.model?.bounds);
        assert.ok(
          Math.abs(workerA_v2.model.bounds.size[0] - 3.0) < 0.1,
          `WorkerA bounds.size[0] should be ~3.0, got ${workerA_v2.model.bounds.size[0]}`,
        );
        assert.ok(
          Math.abs(workerB_v2.model!.bounds!.size[0] - 3.0) < 0.1,
          `WorkerB bounds.size[0] should be ~3.0, got ${workerB_v2.model!.bounds!.size[0]}`,
        );

        // Capture valid PNG frame after live reload
        const frame2 = await host.captureFrame();
        assert.ok(frame2.available);
        assertValidPng(Buffer.from(frame2.base64!, "base64"), "Live Reloaded Blender Scene");

        // 9. Touch-only / NOOP test: update mtime with identical content
        const txHistoryLengthBefore = coordinator.getTransactionHistory().length;
        const now = new Date();
        await utimes(sourceBlendPath, now, now);
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(
          coordinator.getTransactionHistory().length,
          txHistoryLengthBefore,
          "Touch with same bytes must produce NO reload transaction",
        );

        // 10. Failure rollback test: simulated Blender export failure
        runner.shouldFail = true;
        const corruptContent = `CORRUPT_INVALID_BLEND_DATA_CRASH\n`;
        await writeFile(sourceBlendPath, corruptContent);

        // Allow watcher debounce to trigger and coordinator to process
        await new Promise((r) => setTimeout(r, 200));

        // Verify reimportFailed event appeared
        const failureEvents = coordinatorEvents.filter((e) => e.type === "asset.reimportFailed");
        assert.ok(failureEvents.length > 0, "Coordinator must emit asset.reimportFailed on failure");

        // Verify entities in Electron still retain F2 and did not unload
        const qFail = await host.query();
        const workerA_fail = qFail.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        assert.ok(workerA_fail.model?.loaded, "WorkerA model must remain loaded on failed reimport");
        assert.equal(workerA_fail.model.assetFingerprint, f2);

        // 11. Repair test: restore valid Blender fixture (v3 width = 4.0)
        runner.shouldFail = false;
        const v3Promise = coordinator.waitForAssetReload(ASSET_BLENDER_CUBE, 10_000);
        const v3BlendContent = `BLENDER_V400_MAGIC_HEADER_FIXTURE_V3\nKINETRA_WIDTH:4.0\n`;
        await writeFile(sourceBlendPath, v3BlendContent);

        const tx3 = await v3Promise;
        assert.equal(tx3.rootAssetId, ASSET_BLENDER_CUBE);
        const f3 = tx3.newFingerprint;
        assert.notEqual(f3, f2);

        const q3 = await host.query();
        const workerA_v3 = q3.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        assert.equal(workerA_v3.model?.assetFingerprint, f3);
        assert.equal(workerA_v3.model?.templateRevision, 3);
        assert.ok(Math.abs(workerA_v3.model.bounds!.size[0] - 4.0) < 0.1);
      } finally {
        await coordinator.stop();
        await probe.close();
      }
    },
  );
});
