import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { createSyntheticCharacterGlb, createSyntheticGlb } from "@kinetra/asset-pipeline";
import * as THREE from "three";

import {
  ThreeSceneRuntime,
  ModelTemplateCache,
  type AssetResolver,
} from "../src/index.js";

const sceneId = stableId("scene", "reload-test");
const entityAId = stableId("entity", "worker_a");
const entityBId = stableId("entity", "worker_b");
const entityCId = stableId("entity", "unrelated_prop");
const ASSET_WORKER = "asset_model_worker";
const ASSET_PROP = "asset_model_prop";

class MemoryAssetResolver implements AssetResolver {
  readonly assets = new Map<string, Uint8Array>();
  readonly fingerprints = new Map<string, string>();

  setAsset(assetId: string, bytes: Uint8Array, fingerprint: string): void {
    this.assets.set(assetId, bytes);
    this.fingerprints.set(assetId, fingerprint);
  }

  resolve(assetId: string): Uint8Array | undefined {
    return this.assets.get(assetId);
  }

  getFingerprint(assetId: string): string | undefined {
    return this.fingerprints.get(assetId);
  }
}

function createMultiInstanceTestProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "reload-test"),
    name: "Hot Reload Fixture",
    scenes: [
      {
        id: sceneId,
        name: "HotReloadScene",
        entities: [
          {
            id: entityAId,
            name: "WorkerA",
            components: {
              Transform: { position: [-3, 1, 0], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_WORKER },
            },
          },
          {
            id: entityBId,
            name: "WorkerB",
            components: {
              Transform: { position: [3, 1, 0], rotation: [0, -0.5, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_WORKER },
            },
          },
          {
            id: entityCId,
            name: "UnrelatedProp",
            components: {
              Transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_PROP },
            },
          },
        ],
      },
    ],
  };
}

test("ModelTemplateCache: invalidate clears cache and resolveNewTemplate re-parses with new revision", async () => {
  const cache = new ModelTemplateCache();
  const resolver = new MemoryAssetResolver();

  const glbV1 = await createSyntheticGlb({ size: [1, 1, 1] });
  resolver.setAsset("model_x", glbV1, "fp_v1");

  const tmpl1 = await cache.resolveTemplate("model_x", resolver);
  assert.equal(cache.parseCount, 1);
  assert.equal(tmpl1.revision, 1);
  assert.equal(tmpl1.fingerprint, "fp_v1");

  // Subsequent call without invalidation uses cached template
  const tmpl1Cached = await cache.resolveTemplate("model_x", resolver);
  assert.equal(tmpl1Cached, tmpl1);
  assert.equal(cache.parseCount, 1);

  // Invalidate and resolve new template
  const glbV2 = await createSyntheticGlb({ size: [2, 2, 2] });
  resolver.setAsset("model_x", glbV2, "fp_v2");

  const tmpl2 = await cache.resolveNewTemplate("model_x", resolver);
  assert.equal(cache.parseCount, 2);
  assert.equal(tmpl2.revision, 2);
  assert.equal(tmpl2.fingerprint, "fp_v2");
  assert.notEqual(tmpl1, tmpl2);
});

test("ThreeSceneRuntime.reloadAsset: live reload multi-instance entities, preserve transform and ID, isolate unrelated entity", async () => {
  const project = createMultiInstanceTestProject();
  const resolver = new MemoryAssetResolver();

  const workerV1 = await createSyntheticCharacterGlb();
  resolver.setAsset(ASSET_WORKER, workerV1, "fp_worker_v1");

  const propV1 = await createSyntheticGlb({ size: [1, 1, 1] });
  resolver.setAsset(ASSET_PROP, propV1, "fp_prop_v1");

  const runtime = await ThreeSceneRuntime.instantiateAsync(project, sceneId, { assetResolver: resolver });

  // Initial verification
  const initialParseCount = runtime.assetTemplateParseCount;
  assert.equal(initialParseCount, 2); // 1 for worker, 1 for prop

  const metaA1 = runtime.getModelMetadata(entityAId);
  const metaB1 = runtime.getModelMetadata(entityBId);
  const metaC1 = runtime.getModelMetadata(entityCId);
  assert.ok(metaA1?.loaded);
  assert.ok(metaB1?.loaded);
  assert.ok(metaC1?.loaded);
  assert.equal(metaA1.templateRevision, 1);
  assert.equal(metaB1.templateRevision, 1);
  assert.equal(metaC1.templateRevision, 1);
  assert.equal(metaA1.assetFingerprint, "fp_worker_v1");

  const objA = runtime.getObject(entityAId)!;
  const objB = runtime.getObject(entityBId)!;
  const objC = runtime.getObject(entityCId)!;
  assert.deepEqual(objA.position.toArray(), [-3, 1, 0]);
  assert.deepEqual(objB.position.toArray(), [3, 1, 0]);
  assert.deepEqual(objC.position.toArray(), [0, 0, 5]);

  // Update source for ASSET_WORKER to V2
  const workerV2 = await createSyntheticCharacterGlb();
  resolver.setAsset(ASSET_WORKER, workerV2, "fp_worker_v2");

  // Perform live reload
  const reloadResult = await runtime.reloadAsset(ASSET_WORKER, resolver);
  assert.equal(reloadResult.success, true);
  assert.deepEqual(reloadResult.affectedEntities.sort(), [entityAId, entityBId].sort());

  // Verify parseCount incremented by exactly 1 for the two reloaded entities
  assert.equal(runtime.assetTemplateParseCount, initialParseCount + 1);

  // Verify entity A and B reloaded to v2
  const metaA2 = runtime.getModelMetadata(entityAId);
  const metaB2 = runtime.getModelMetadata(entityBId);
  assert.equal(metaA2?.templateRevision, 2);
  assert.equal(metaB2?.templateRevision, 2);
  assert.equal(metaA2?.assetFingerprint, "fp_worker_v2");
  assert.equal(metaB2?.assetFingerprint, "fp_worker_v2");

  // Verify entity C (unrelated) was NOT reloaded
  const metaC2 = runtime.getModelMetadata(entityCId);
  assert.equal(metaC2?.templateRevision, 1);
  assert.equal(metaC2?.assetFingerprint, "fp_prop_v1");

  // Verify world transforms and entity IDs are completely preserved
  assert.equal(runtime.getObject(entityAId), objA);
  assert.equal(runtime.getObject(entityBId), objB);
  assert.equal(runtime.getObject(entityCId), objC);
  assert.deepEqual(objA.position.toArray(), [-3, 1, 0]);
  assert.deepEqual(objB.position.toArray(), [3, 1, 0]);
  assert.deepEqual(objC.position.toArray(), [0, 0, 5]);

  // Verify independent skeletons on new instances
  const instA2 = runtime.getInstance(entityAId)!;
  const instB2 = runtime.getInstance(entityBId)!;
  assert.ok(instA2 && instB2);
  assert.notEqual(instA2.instanceId, instB2.instanceId);
  const skelA2 = Array.from(instA2.skeletons)[0]!;
  const skelB2 = Array.from(instB2.skeletons)[0]!;
  assert.ok(skelA2 && skelB2);
  assert.notEqual(skelA2, skelB2, "Reloaded instances must have distinct Skeletons");

  // Verify refCount on new template is 2
  assert.equal(metaA2?.resourceSharing?.templateRefCount, 2);

  runtime.dispose();
});

test("ThreeSceneRuntime.reloadAsset: failure rollback preserves live v2 when corrupt v3 is loaded, and recovers on v4", async () => {
  const project = createMultiInstanceTestProject();
  const resolver = new MemoryAssetResolver();

  const workerV2 = await createSyntheticCharacterGlb();
  resolver.setAsset(ASSET_WORKER, workerV2, "fp_v2");

  const runtime = await ThreeSceneRuntime.instantiateAsync(project, sceneId, { assetResolver: resolver });
  const metaBefore = runtime.getModelMetadata(entityAId);
  assert.equal(metaBefore?.templateRevision, 1);

  // Introduce corrupt v3 bytes
  const corruptBytes = new Uint8Array([0x47, 0x4c, 0x54, 0x46, 0x00, 0x00, 0x00, 0x00]); // truncated/invalid header
  resolver.setAsset(ASSET_WORKER, corruptBytes, "fp_v3_corrupt");

  // Attempt reload with corrupt bytes
  const failReload = await runtime.reloadAsset(ASSET_WORKER, resolver);
  assert.equal(failReload.success, false);
  assert.ok(failReload.error);

  // Verify live entity is STILL loaded with v2 and healthy
  const metaAfterFail = runtime.getModelMetadata(entityAId);
  assert.equal(metaAfterFail?.loaded, true);
  assert.equal(metaAfterFail?.templateRevision, 1);
  assert.equal(metaAfterFail?.assetFingerprint, "fp_v2");

  // Now provide valid v4
  const workerV4 = await createSyntheticCharacterGlb();
  resolver.setAsset(ASSET_WORKER, workerV4, "fp_v4_repaired");

  const recoverReload = await runtime.reloadAsset(ASSET_WORKER, resolver);
  assert.equal(recoverReload.success, true);

  const metaRecovered = runtime.getModelMetadata(entityAId);
  assert.equal(metaRecovered?.loaded, true);
  assert.equal(metaRecovered?.templateRevision, 2);
  assert.equal(metaRecovered?.assetFingerprint, "fp_v4_repaired");

  runtime.dispose();
});
