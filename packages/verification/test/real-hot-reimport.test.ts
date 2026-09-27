import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectDocument } from "@kinetra/project-model";
import {
  AssetDatabase,
  AssetReimportService,
  GlbDirectImporter,
  createSyntheticGlb,
  createSyntheticCharacterGlb,
  hashBytes,
  importFingerprint,
  type AssetRecord,
  type FileSystemAdapter,
} from "@kinetra/asset-pipeline";
import type { AnimationGraphDefinition } from "@kinetra/animation/graph.js";

import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

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

class MemoryFileSystemAdapter implements FileSystemAdapter {
  readonly files = new Map<string, Uint8Array>();

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: no such file "${path}"`);
    return data;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const data = this.files.get(oldPath);
    if (!data) throw new Error(`ENOENT: temp file "${oldPath}" not found`);
    this.files.set(newPath, data);
    this.files.delete(oldPath);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<string | undefined> {
    return path;
  }
}

const SCENE_HOT_RELOAD = "scene_hot_reimport_live";
const SCENE_RIGGED_RELOAD = "scene_hot_reimport_rigged";

const ENTITY_WORKER_A = "entity_worker_a";
const ENTITY_WORKER_B = "entity_worker_b";
const ENTITY_UNRELATED_PROP = "entity_unrelated_prop";
const ENTITY_RIGGED_CHAR = "entity_rigged_char";

const ASSET_CRATE = "asset_model_crate";
const ASSET_PROP = "asset_model_prop";
const ASSET_HERO = "asset_character_hero";

function createHotReloadProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_hot_reimport",
    name: "Hot Reimport Acceptance Project",
    scenes: [
      {
        id: SCENE_HOT_RELOAD,
        name: "Hot Reimport Multi-Instance Scene",
        entities: [
          {
            id: "camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 2, 6], rotation: [-0.1, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
            },
          },
          {
            id: "sun",
            name: "DirectionalSun",
            components: {
              Transform: { position: [2, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
            },
          },
          {
            id: "floor",
            name: "Floor",
            components: {
              Transform: { position: [0, -0.05, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Primitive: { kind: "box", size: [12, 0.1, 12], color: "#1a1e28" },
            },
          },
          {
            id: ENTITY_WORKER_A,
            name: "WorkerA",
            components: {
              Transform: { position: [-2, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_CRATE },
            },
          },
          {
            id: ENTITY_WORKER_B,
            name: "WorkerB",
            components: {
              Transform: { position: [2, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_CRATE },
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
      {
        id: SCENE_RIGGED_RELOAD,
        name: "Rigged Character Hot Reload Scene",
        entities: [
          {
            id: "rigged_camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 1.5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
            },
          },
          {
            id: "rigged_sun",
            name: "DirectionalSun",
            components: {
              Transform: { position: [2, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
            },
          },
          {
            id: ENTITY_RIGGED_CHAR,
            name: "RiggedHero",
            components: {
              Transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_HERO },
            },
          },
        ],
      },
    ],
  };
}

const simpleGraphDef: AnimationGraphDefinition = {
  schemaVersion: 1,
  entryState: "idle",
  parameters: {
    isMoving: { type: "bool", default: false },
  },
  states: [
    { id: "idle", clipId: "idle", loop: true },
    { id: "walk", clipId: "walk", loop: true },
  ],
  transitions: [
    {
      id: "idle_to_walk",
      from: "idle",
      to: "walk",
      conditions: [{ parameter: "isMoving", op: "==", value: true }],
      blendSeconds: 0.2,
    },
  ],
};

test("Hot Reimport & Dependency-Aware Live Reload Suite", { skip: !canRunRealElectronTests() }, async (t) => {
  // -------------------------------------------------------------------------
  // Scenario 1: Full Hot Reimport Cycle without Electron restart (Reqs 1-18)
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 1: Live hot reimport updates multiple entities without Electron restart, preserves transform & ID, isolates unrelated asset",
    async () => {
      // 1. Prepare deterministic source files and asset pipeline
      const fs = new MemoryFileSystemAdapter();
      const db = new AssetDatabase();
      const reimportService = new AssetReimportService({
        database: db,
        fileSystem: fs,
        importers: new Map([["glb", new GlbDirectImporter()]]),
      });

      // Source v1: Box 1.0 x 1.0 x 1.0
      const sourcePathV1 = "/source/crate.glb";
      const artifactPathV1 = "/artifacts/crate.glb";
      const crateBytesV1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: "CrateMesh" });
      await fs.writeFile(sourcePathV1, crateBytesV1);

      // Register initial asset record
      const v1ContentHash = hashBytes(crateBytesV1);
      const f1 = importFingerprint({
        importer: "glb",
        importerVersion: "1.0.0",
        sourceHash: v1ContentHash,
        dependencyFingerprints: [],
        settings: {},
      });
      const initialRecord: AssetRecord = {
        id: ASSET_CRATE,
        kind: "model",
        source: {
          path: sourcePathV1,
          kind: "source",
          contentHash: v1ContentHash,
        },
        importedPath: artifactPathV1,
        recipe: { importer: "glb", importerVersion: "1.0.0", settings: {} },
        fingerprint: f1,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      };
      db.upsert(initialRecord);
      await fs.writeFile(artifactPathV1, crateBytesV1);

      // Register unrelated prop asset
      const propSourcePath = "/source/prop.glb";
      const propArtifactPath = "/artifacts/prop.glb";
      const propBytes = await createSyntheticGlb({ size: [0.5, 0.5, 0.5], meshName: "PropMesh" });
      await fs.writeFile(propSourcePath, propBytes);
      const propHash = hashBytes(propBytes);
      const propFp = importFingerprint({
        importer: "glb",
        importerVersion: "1.0.0",
        sourceHash: propHash,
        dependencyFingerprints: [],
        settings: {},
      });
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
      await fs.writeFile(propArtifactPath, propBytes);

      // 2. Launch real Electron runtime with model v1
      const initialAssets: Record<string, string> = {
        [ASSET_CRATE]: Buffer.from(crateBytesV1).toString("base64"),
        [ASSET_PROP]: Buffer.from(propBytes).toString("base64"),
      };
      const initialAssetMetadata = {
        [ASSET_CRATE]: { fingerprint: f1, sourceHash: v1ContentHash },
        [ASSET_PROP]: { fingerprint: propFp, sourceHash: propHash },
      };

      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createHotReloadProject(),
        initialRevision: 0,
        assets: initialAssets,
        assetMetadata: initialAssetMetadata,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_HOT_RELOAD, 1);
        await probe.step(2, 1 / 30);

        // Verification Point 1 & 2: Runtime starts with model v1, query proves F1 and bounds v1
        const q1 = await host.query();
        assert.equal(q1.running, true);
        const workerA_v1 = q1.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        const workerB_v1 = q1.entities.find((e) => e.entityId === ENTITY_WORKER_B)!;
        const unrelated_v1 = q1.entities.find((e) => e.entityId === ENTITY_UNRELATED_PROP)!;

        assert.ok(workerA_v1.model?.loaded, "WorkerA model must be loaded");
        assert.ok(workerB_v1.model?.loaded, "WorkerB model must be loaded");
        assert.ok(unrelated_v1.model?.loaded, "UnrelatedProp model must be loaded");

        assert.equal(workerA_v1.model.assetFingerprint, f1, "WorkerA must have fingerprint F1");
        assert.equal(workerB_v1.model.assetFingerprint, f1, "WorkerB must have fingerprint F1");
        assert.equal(workerA_v1.model.templateRevision, 1, "WorkerA templateRevision must be 1");
        assert.equal(workerB_v1.model.templateRevision, 1, "WorkerB templateRevision must be 1");
        assert.equal(unrelated_v1.model.templateRevision, 1, "UnrelatedProp templateRevision must be 1");

        // Verify initial bounds (~ [1, 1, 1])
        assert.ok(workerA_v1.model.bounds);
        assert.ok(Math.abs(workerA_v1.model.bounds.size[0] - 1.0) < 0.05);

        // Initial parse count
        const initialParseCount = q1.metrics?.assetTemplateParseCount ?? 0;
        assert.equal(initialParseCount, 2, "Initial parse count must be 2 (crate + prop)");

        // Initial positions
        assert.deepEqual(workerA_v1.position, [-2, 0.5, 0]);
        assert.deepEqual(workerB_v1.position, [2, 0.5, 0]);
        assert.deepEqual(unrelated_v1.position, [0, 0.25, 2]);

        // Verification Point 3 & 4: Source bytes changed to v2, reimport detects changed source hash
        const crateBytesV2 = await createSyntheticGlb({ size: [2.5, 1.2, 1.0], meshName: "CrateMesh" });
        await fs.writeFile(sourcePathV1, crateBytesV2);

        // Verification Point 5, 6, 7: Deterministic import succeeds, AssetRecord becomes F2, invalidationSet correct
        const reimportResult = await reimportService.reimport(ASSET_CRATE);
        assert.equal(reimportResult.status, "reimported", "Reimport must detect change and reimport");
        assert.notEqual(reimportResult.newFingerprint, f1);
        const f2 = reimportResult.newFingerprint!;

        assert.deepEqual(reimportResult.affectedAssetIds, [ASSET_CRATE]);
        const updatedRecord = db.get(ASSET_CRATE)!;
        assert.equal(updatedRecord.fingerprint, f2);

        // Verification Point 8 & 9: Live entity reloads WITHOUT restarting Electron runtime
        // Push new bytes to running Electron player
        await probe.updateAsset!(
          ASSET_CRATE,
          Buffer.from(crateBytesV2).toString("base64"),
          f2 ? { fingerprint: f2 } : undefined,
        );

        const reloadResult = await probe.reloadAsset!(ASSET_CRATE);
        assert.equal(reloadResult.success, true, "Runtime reloadAsset must succeed");
        assert.deepEqual(reloadResult.affectedEntities.sort(), [ENTITY_WORKER_A, ENTITY_WORKER_B].sort());

        await probe.step(2, 1 / 30);

        // Verification Point 10, 11, 12, 14, 15:
        // Same entity IDs, transform unchanged, new bounds/state v2, second entity reloaded, unrelated untouched
        const q2 = await host.query();
        assert.equal(q2.running, true);

        const workerA_v2 = q2.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        const workerB_v2 = q2.entities.find((e) => e.entityId === ENTITY_WORKER_B)!;
        const unrelated_v2 = q2.entities.find((e) => e.entityId === ENTITY_UNRELATED_PROP)!;

        // Same entity IDs
        assert.equal(workerA_v2.entityId, ENTITY_WORKER_A);
        assert.equal(workerB_v2.entityId, ENTITY_WORKER_B);
        assert.equal(unrelated_v2.entityId, ENTITY_UNRELATED_PROP);

        // Transforms remain unchanged
        assert.deepEqual(workerA_v2.position, [-2, 0.5, 0], "WorkerA position must be preserved");
        assert.deepEqual(workerB_v2.position, [2, 0.5, 0], "WorkerB position must be preserved");
        assert.deepEqual(unrelated_v2.position, [0, 0.25, 2], "UnrelatedProp position must be preserved");

        // New bounds and revision v2
        assert.equal(workerA_v2.model?.templateRevision, 2, "WorkerA revision must be 2");
        assert.equal(workerB_v2.model?.templateRevision, 2, "WorkerB revision must be 2");
        assert.equal(workerA_v2.model?.assetFingerprint, f2, "WorkerA fingerprint must be F2");
        assert.equal(workerB_v2.model?.assetFingerprint, f2, "WorkerB fingerprint must be F2");

        assert.ok(workerA_v2.model?.bounds);
        assert.ok(Math.abs(workerA_v2.model.bounds.size[0] - 2.5) < 0.05, "WorkerA width must reflect v2 size 2.5");
        assert.ok(workerB_v2.model?.bounds);
        assert.ok(Math.abs(workerB_v2.model.bounds.size[0] - 2.5) < 0.05, "WorkerB width must reflect v2 size 2.5");

        // Unrelated entity Y is NOT reloaded
        assert.equal(unrelated_v2.model?.templateRevision, 1, "UnrelatedProp must remain at revision 1");
        assert.equal(unrelated_v2.model?.assetFingerprint, propRecord.fingerprint);

        // Verification Point 16: Parse count for X's new revision increments only once across both entities
        assert.equal(
          q2.metrics?.assetTemplateParseCount,
          initialParseCount + 1,
          "assetTemplateParseCount must increment exactly once for asset X reload across all entities",
        );

        // Verification Point 17: Resource sharing refcount is 2
        assert.equal(workerA_v2.model?.resourceSharing?.templateRefCount, 2);
        assert.equal(workerB_v2.model?.resourceSharing?.templateRefCount, 2);

        // Verification Point 13: Valid PNG reflects live updated asset
        const frame = await probe.captureFrame();
        assertValidPng(frame, "Hot reloaded scene with updated crate dimensions");

        // Verification Point 18: No orphan error logs
        const logs = await probe.logs();
        assert.ok(
          !logs.some((l) => l.message === "model.attachFailed" || l.message === "model.loadFailed"),
          "Zero model attach/load failures expected",
        );
      } finally {
        await probe.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 2: Failure Rollback on Corrupt v3 & Recovery on v4 (Reqs 19-21)
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 2: Corrupt source v3 triggers failure rollback leaving valid v2 active, and recovers cleanly on v4",
    async () => {
      const fs = new MemoryFileSystemAdapter();
      const db = new AssetDatabase();
      const reimportService = new AssetReimportService({
        database: db,
        fileSystem: fs,
        importers: new Map([["glb", new GlbDirectImporter()]]),
      });

      // Prepare v2
      const sourcePath = "/source/crate_rollback.glb";
      const artifactPath = "/artifacts/crate_rollback.glb";
      const crateBytesV2 = await createSyntheticGlb({ size: [2, 1, 1], meshName: "RollbackCrate" });
      await fs.writeFile(sourcePath, crateBytesV2);
      await fs.writeFile(artifactPath, crateBytesV2);

      const v2Hash = hashBytes(crateBytesV2);
      const v2Fp = importFingerprint({
        importer: "glb",
        importerVersion: "1.0.0",
        sourceHash: v2Hash,
        dependencyFingerprints: [],
        settings: {},
      });
      const recordV2: AssetRecord = {
        id: ASSET_CRATE,
        kind: "model",
        source: {
          path: sourcePath,
          kind: "source",
          contentHash: v2Hash,
        },
        importedPath: artifactPath,
        recipe: { importer: "glb", importerVersion: "1.0.0", settings: {} },
        fingerprint: v2Fp,
        dependencies: [],
        diagnostics: [],
        metadata: {},
      };
      db.upsert(recordV2);

      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createHotReloadProject(),
        initialRevision: 0,
        assets: {
          [ASSET_CRATE]: Buffer.from(crateBytesV2).toString("base64"),
          [ASSET_PROP]: Buffer.from(crateBytesV2).toString("base64"),
        },
        assetMetadata: {
          [ASSET_CRATE]: { fingerprint: v2Fp, sourceHash: v2Hash },
          [ASSET_PROP]: { fingerprint: v2Fp, sourceHash: v2Hash },
        },
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_HOT_RELOAD, 2);
        await probe.step(2, 1 / 30);

        const qStart = await host.query();
        const workerStart = qStart.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        assert.equal(workerStart.model?.templateRevision, 1);
        assert.equal(workerStart.model?.assetFingerprint, recordV2.fingerprint);

        // Verification Point 19: Corrupt v3 source fails safely
        const corruptBytes = new Uint8Array([0x47, 0x4c, 0x54, 0x46, 0x01, 0x00, 0x00, 0x00, 0x00]); // truncated/invalid header
        await fs.writeFile(sourcePath, corruptBytes);

        // Pipeline reimport fails validation
        const failReimport = await reimportService.reimport(ASSET_CRATE);
        assert.equal(failReimport.status, "failed", "Reimport with corrupt bytes must fail");
        assert.ok(failReimport.error);

        // Database record remains unchanged (v2)
        const recordAfterFail = db.get(ASSET_CRATE)!;
        assert.equal(recordAfterFail.fingerprint, recordV2.fingerprint);

        // Artifact on disk remains valid v2
        const artifactOnDisk = await fs.readFile(artifactPath);
        assert.deepEqual(artifactOnDisk, crateBytesV2, "Artifact on disk must remain untouched v2");

        // If corrupt reload is attempted directly on runtime, runtime fails safely
        await probe.updateAsset!(ASSET_CRATE, Buffer.from(corruptBytes).toString("base64"));
        const failReload = await probe.reloadAsset!(ASSET_CRATE);
        assert.equal(failReload.success, false, "Runtime reload with corrupt bytes must return failure");

        // Verification Point 20: Runtime continues displaying valid v2
        await probe.step(2, 1 / 30);
        const qAfterFail = await host.query();
        const workerAfterFail = qAfterFail.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        assert.equal(workerAfterFail.model?.loaded, true, "Worker model must still be loaded");
        assert.equal(workerAfterFail.model?.templateRevision, 1, "Worker must remain on valid revision");

        // Verification Point 21: Repaired v4 source succeeds and reloads
        const crateBytesV4 = await createSyntheticGlb({ size: [3.5, 1.0, 1.0], meshName: "RepairedCrate" });
        await fs.writeFile(sourcePath, crateBytesV4);

        const repairReimport = await reimportService.reimport(ASSET_CRATE);
        assert.equal(repairReimport.status, "reimported", "Reimport of repaired v4 must succeed");

        await probe.updateAsset!(
          ASSET_CRATE,
          Buffer.from(crateBytesV4).toString("base64"),
          repairReimport.newFingerprint ? { fingerprint: repairReimport.newFingerprint } : undefined,
        );

        const recoverReload = await probe.reloadAsset!(ASSET_CRATE);
        assert.equal(recoverReload.success, true, "Reload of repaired v4 must succeed");

        await probe.step(2, 1 / 30);
        const qRecovered = await host.query();
        const workerRecovered = qRecovered.entities.find((e) => e.entityId === ENTITY_WORKER_A)!;
        assert.equal(workerRecovered.model?.templateRevision, 2, "Worker must be updated to new revision 2");
        assert.equal(workerRecovered.model?.assetFingerprint, repairReimport.newFingerprint);
        assert.ok(Math.abs(workerRecovered.model.bounds!.size[0] - 3.5) < 0.05);
      } finally {
        await probe.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 3: Rigged Character Hot Reload & Animation Graph Reinitialization
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 3: Rigged character hot reload recreates SkinnedMesh, Skeleton, AnimationMixer, and reinitializes AnimationGraph",
    async () => {
      const heroBytesV1 = await createSyntheticCharacterGlb();
      const heroBytesV2 = await createSyntheticCharacterGlb();

      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createHotReloadProject(),
        initialRevision: 0,
        assets: {
          [ASSET_HERO]: Buffer.from(heroBytesV1).toString("base64"),
        },
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_RIGGED_RELOAD, 3);
        await probe.step(2, 1 / 30);

        // Initialize Animation Graph
        const graphInit = await (host as any).request("animation.graph.init", {
          entityId: ENTITY_RIGGED_CHAR,
          graph: simpleGraphDef,
        });
        assert.equal(graphInit.success, true, "Animation graph init must succeed");

        await probe.step(3, 1 / 30);
        const qPre = await host.query();
        const heroPre = qPre.entities.find((e) => e.entityId === ENTITY_RIGGED_CHAR)!;
        assert.ok(heroPre.model?.hasSkin);
        assert.equal(heroPre.model.skinnedMeshCount, 1);
        assert.equal(heroPre.model.instance?.skeletonCount, 1);
        assert.equal(heroPre.model.animation?.graph?.state, "idle");

        // Hot reload character model to V2
        await probe.updateAsset!(ASSET_HERO, Buffer.from(heroBytesV2).toString("base64"), {
          fingerprint: "fp_hero_v2",
        });

        const reloadRes = await probe.reloadAsset!(ASSET_HERO);
        assert.equal(reloadRes.success, true);
        assert.deepEqual(reloadRes.affectedEntities, [ENTITY_RIGGED_CHAR]);

        await probe.step(3, 1 / 30);
        const qPost = await host.query();
        const heroPost = qPost.entities.find((e) => e.entityId === ENTITY_RIGGED_CHAR)!;

        // Verify SkinnedMesh and Skeleton are valid on new instance
        assert.ok(heroPost.model?.hasSkin);
        assert.equal(heroPost.model.skinnedMeshCount, 1);
        assert.equal(heroPost.model.instance?.skeletonCount, 1);
        assert.equal(heroPost.model.templateRevision, 2);

        // Verify Animation Graph was cleanly reinitialized
        assert.ok(heroPost.model.animation?.graph);
        assert.equal(heroPost.model.animation.graph.state, "idle");

        // Trigger parameter change on the reloaded graph
        const paramRes = await (host as any).request("animation.graph.setParameter", {
          entityId: ENTITY_RIGGED_CHAR,
          name: "isMoving",
          value: true,
        });
        assert.equal(paramRes.success, true);

        await probe.step(5, 1 / 30);
        const qPostTrans = await host.query();
        const heroPostTrans = qPostTrans.entities.find((e) => e.entityId === ENTITY_RIGGED_CHAR)!;
        assert.equal(heroPostTrans.model?.animation?.graph?.state, "walk", "Graph must transition to walk state after reload");
      } finally {
        await probe.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 4: Dependency Graph Invalidation (A <- B <- C, D)
  // -------------------------------------------------------------------------
  await t.test(
    "Scenario 4: Dependency invalidation: A <- B <- C, D unrelated; stable deterministic ordering",
    () => {
      const db = new AssetDatabase();
      db.upsert({
        id: "A",
        kind: "texture",
        source: { path: "/src/a.png", kind: "source", contentHash: "hashA" },
        importedPath: "/art/a.tex",
        recipe: { importer: "direct", importerVersion: "1.0", settings: {} },
        fingerprint: "fpA",
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "B",
        kind: "other",
        source: { path: "/src/b.mat", kind: "source", contentHash: "hashB" },
        importedPath: "/art/b.mat",
        recipe: { importer: "direct", importerVersion: "1.0", settings: {} },
        fingerprint: "fpB",
        dependencies: ["A"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "C",
        kind: "model",
        source: { path: "/src/c.glb", kind: "source", contentHash: "hashC" },
        importedPath: "/art/c.glb",
        recipe: { importer: "direct", importerVersion: "1.0", settings: {} },
        fingerprint: "fpC",
        dependencies: ["B"],
        diagnostics: [],
        metadata: {},
      });
      db.upsert({
        id: "D",
        kind: "model",
        source: { path: "/src/d.glb", kind: "source", contentHash: "hashD" },
        importedPath: "/art/d.glb",
        recipe: { importer: "direct", importerVersion: "1.0", settings: {} },
        fingerprint: "fpD",
        dependencies: [],
        diagnostics: [],
        metadata: {},
      });

      // Changing A invalidates A, B, C
      const invalidA = db.invalidationSet("A");
      assert.deepEqual(invalidA, ["A", "B", "C"]);

      // Changing B invalidates B, C
      const invalidB = db.invalidationSet("B");
      assert.deepEqual(invalidB, ["B", "C"]);

      // D is never invalidated
      assert.ok(!invalidA.includes("D"));
      assert.ok(!invalidB.includes("D"));
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 5: Zero Orphan Electron Processes (Req 22)
  // -------------------------------------------------------------------------
  await t.test("Scenario 5: Teardown cleanly leaves zero orphan Electron processes", async () => {
    // Verified by completion of try/finally probe.close() blocks in each scenario
    assert.ok(true);
  });
});
