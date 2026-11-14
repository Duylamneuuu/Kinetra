import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { ModelTemplateCache, ThreeSceneRuntime, type AssetResolver } from "../src/index.js";

// Failure-side companions of async-races.test.ts (Refs #187 item 2): a resolver that FAILS after the
// load was superseded (detach / newer attach / invalidate / dispose) must not poison the new state.

interface Pending {
  assetId: string;
  release(bytes: Uint8Array): void;
  fail(error: Error): void;
}

class GatedResolver implements AssetResolver {
  readonly pending: Pending[] = [];

  resolve(assetId: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending.push({
        assetId,
        release: (bytes) => resolve(bytes),
        fail: (error) => reject(error),
      });
    });
  }

  async until(count: number): Promise<void> {
    for (let i = 0; i < 200 && this.pending.length < count; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(this.pending.length >= count, `expected ${count} resolve calls, saw ${this.pending.length}`);
  }
}

const sceneId = stableId("scene", "async-race-failures");
const entityId = stableId("entity", "prop");

function projectWithModel(assetId: string): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "async-race-failures"),
    name: "Async race failures",
    scenes: [
      {
        id: sceneId,
        name: "Races",
        entities: [
          {
            id: entityId,
            name: "Prop",
            components: {
              Transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId },
            },
          },
        ],
      },
    ],
  };
}

test("attachModel: a resolver failure after detachModel reports the supersede, not a load error", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);

  const attaching = runtime.attachModel(entityId, "model_b", resolver);
  await resolver.until(1);
  runtime.detachModel(entityId);
  resolver.pending[0]!.fail(new Error("disk went away"));
  const result = await attaching;

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /superseded/);
  assert.doesNotMatch(result.error ?? "", /disk went away/);
  assert.equal(runtime.getModelMetadata(entityId)?.error, undefined, "a cancelled load leaves no stale error behind");
  assert.equal(runtime.instanceCount, 0);
});

test("attachModel: an older attach that fails late does not mark the newer winner as failed", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  const object = runtime.getObject(entityId)!;
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });

  const first = runtime.attachModel(entityId, "model_first", resolver);
  await resolver.until(1);
  const second = runtime.attachModel(entityId, "model_second", resolver);
  await resolver.until(2);

  resolver.pending[1]!.release(glb);
  const secondResult = await second;
  resolver.pending[0]!.fail(new Error("first asset is corrupt"));
  const firstResult = await first;

  assert.equal(secondResult.success, true);
  assert.equal(firstResult.success, false);
  assert.match(firstResult.error ?? "", /superseded/);
  const metadata = runtime.getModelMetadata(entityId);
  assert.equal(metadata?.assetId, "model_second");
  assert.equal(metadata?.loaded, true, "the winner stays loaded");
  assert.equal(metadata?.error, undefined, "the loser's failure must not leak onto the winner");
  assert.equal(runtime.instanceCount, 1);
  assert.equal(object.children.length, 1);
});

test("loadModels: a resolver failure after detachModel records no error on the entity", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);

  const loading = runtime.loadModels(resolver);
  await resolver.until(1);
  runtime.detachModel(entityId);
  resolver.pending[0]!.fail(new Error("late failure"));
  await loading;

  assert.equal(runtime.getModelMetadata(entityId)?.error, undefined);
  assert.equal(runtime.instanceCount, 0);
});

test("attachModel: a genuine (current) resolver failure still records the error", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);

  const attaching = runtime.attachModel(entityId, "model_b", resolver);
  await resolver.until(1);
  resolver.pending[0]!.fail(new Error("not found on disk"));
  const result = await attaching;

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not found on disk/);
  assert.equal(runtime.getModelMetadata(entityId)?.loaded, false);
  assert.match(runtime.getModelMetadata(entityId)?.error ?? "", /not found on disk/);
});

test("template cache: a failed superseded load neither clears the newer in-flight load nor the cached template", async () => {
  const cache = new ModelTemplateCache();
  const resolver = new GatedResolver();
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });

  const oldLoad = cache.resolveTemplate("model_x", resolver);
  await resolver.until(1);
  const newLoad = cache.resolveNewTemplate("model_x", resolver);
  await resolver.until(2);

  const oldFailure = assert.rejects(oldLoad, /old bytes unreadable/);
  resolver.pending[0]!.fail(new Error("old bytes unreadable"));
  await oldFailure;

  // The newer load is still joinable: no extra resolve call.
  const joined = cache.resolveTemplate("model_x", resolver);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolver.pending.length, 2, "the newer in-flight load must survive the older one failing");

  resolver.pending[1]!.release(glb);
  const template = await newLoad;
  assert.equal(await joined, template);
  assert.equal(cache.get("model_x"), template);
});

test("reloadAsset: a runtime that is already disposed refuses without resolving anything", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  runtime.dispose();

  const result = await runtime.reloadAsset("model_a", resolver);

  assert.equal(result.success, false);
  assert.deepEqual(result.affectedEntities, []);
  assert.match(result.error ?? "", /disposed/);
  assert.equal(resolver.pending.length, 0);
});

test("reloadAsset: dispose while the new bytes resolve reports disposed and keeps no template alive", async () => {
  const loadResolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  const loading = runtime.loadModels(loadResolver);
  await loadResolver.until(1);
  loadResolver.pending[0]!.release(await createSyntheticGlb({ size: [1, 1, 1] }));
  await loading;
  assert.equal(runtime.instanceCount, 1);

  const reloadResolver = new GatedResolver();
  const reloading = runtime.reloadAsset("model_a", reloadResolver);
  await reloadResolver.until(1);
  runtime.dispose();
  reloadResolver.pending[0]!.release(await createSyntheticGlb({ size: [2, 2, 2] }));
  const result = await reloading;

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /disposed/);
  assert.equal(runtime.instanceCount, 0);
  assert.equal(runtime.getTemplateCache().has("model_a"), false);
});

test("reloadAsset: a resolver failure while the entity was detached leaves the detached state alone", async () => {
  const loadResolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  const loading = runtime.loadModels(loadResolver);
  await loadResolver.until(1);
  loadResolver.pending[0]!.release(await createSyntheticGlb({ size: [1, 1, 1] }));
  await loading;

  const reloadResolver = new GatedResolver();
  const reloading = runtime.reloadAsset("model_a", reloadResolver);
  await reloadResolver.until(1);
  runtime.detachModel(entityId);
  reloadResolver.pending[0]!.fail(new Error("reimport blew up"));
  const result = await reloading;

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /reimport blew up/);
  assert.equal(runtime.instanceCount, 0, "the failed reload must not resurrect the detached instance");
  assert.equal(runtime.getModelMetadata(entityId)?.loaded, false);
});
