import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { ModelTemplateCache, ThreeSceneRuntime, type AssetResolver } from "../src/index.js";

interface Pending {
  assetId: string;
  release(bytes: Uint8Array): void;
  fail(error: Error): void;
}

/** Resolver whose every `resolve` call stays pending until the test releases it. */
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

  /** Waits until `count` resolve calls are pending (the async loaders reached the resolver). */
  async until(count: number): Promise<void> {
    for (let i = 0; i < 200 && this.pending.length < count; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(this.pending.length >= count, `expected ${count} resolve calls, saw ${this.pending.length}`);
  }
}

const sceneId = stableId("scene", "async-races");
const entityId = stableId("entity", "prop");

function projectWithModel(assetId: string): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "async-races"),
    name: "Async races",
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

test("template cache: a stale load finishing after resolveNewTemplate does not overwrite the newer template", async () => {
  const cache = new ModelTemplateCache();
  const resolver = new GatedResolver();
  const glbOld = await createSyntheticGlb({ size: [1, 1, 1] });
  const glbNew = await createSyntheticGlb({ size: [2, 2, 2] });

  const oldLoad = cache.resolveTemplate("model_x", resolver);
  await resolver.until(1);
  const newLoad = cache.resolveNewTemplate("model_x", resolver);
  await resolver.until(2);

  // The reimported bytes arrive first, then the slow initial load finishes.
  resolver.pending[1]!.release(glbNew);
  const newTemplate = await newLoad;
  resolver.pending[0]!.release(glbOld);
  await oldLoad;

  assert.equal(cache.get("model_x"), newTemplate, "the cache must keep serving the newest load");
  assert.equal(await cache.resolveTemplate("model_x", resolver), newTemplate);
  assert.equal(resolver.pending.length, 2, "no further resolve call is needed");
});

test("template cache: a finished stale load does not drop the newer in-flight load", async () => {
  const cache = new ModelTemplateCache();
  const resolver = new GatedResolver();
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });

  const oldLoad = cache.resolveTemplate("model_x", resolver);
  await resolver.until(1);
  const newLoad = cache.resolveNewTemplate("model_x", resolver);
  await resolver.until(2);

  resolver.pending[0]!.release(glb);
  await oldLoad;

  // A third caller must join the still-running newer load instead of starting its own.
  const joined = cache.resolveTemplate("model_x", resolver);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolver.pending.length, 2, "the newer in-flight load must still be joinable");

  resolver.pending[1]!.release(glb);
  const newTemplate = await newLoad;
  assert.equal(await joined, newTemplate);
  assert.equal(cache.get("model_x"), newTemplate);
});

test("template cache: a load that finishes after dispose() is released instead of cached", async () => {
  const cache = new ModelTemplateCache();
  const resolver = new GatedResolver();
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });

  const load = cache.resolveTemplate("model_x", resolver);
  await resolver.until(1);
  cache.dispose();
  resolver.pending[0]!.release(glb);

  await assert.rejects(load, /disposed/);
  assert.equal(cache.has("model_x"), false);
});

test("loadModels: a runtime disposed while assets resolve ends with no instance", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  const loading = runtime.loadModels(resolver);
  await resolver.until(1);

  runtime.dispose();
  resolver.pending[0]!.release(await createSyntheticGlb({ size: [1, 1, 1] }));
  await loading;

  assert.equal(runtime.instanceCount, 0, "no instance may be created in a disposed runtime");
  assert.equal(runtime.getTemplateCache().has("model_a"), false);
});

test("attachModel: a runtime disposed while the asset resolves reports failure and leaks no instance", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  const attaching = runtime.attachModel(entityId, "model_b", resolver);
  await resolver.until(1);

  runtime.dispose();
  resolver.pending[0]!.release(await createSyntheticGlb({ size: [1, 1, 1] }));
  const result = await attaching;

  assert.equal(result.success, false);
  assert.equal(runtime.instanceCount, 0);
});

test("attachModel: overlapping attaches on one entity keep only the latest request and leak no scene", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  const object = runtime.getObject(entityId)!;
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });

  const first = runtime.attachModel(entityId, "model_first", resolver);
  await resolver.until(1);
  const second = runtime.attachModel(entityId, "model_second", resolver);
  await resolver.until(2);

  // The newest request resolves first; the older one finishes late.
  resolver.pending[1]!.release(glb);
  const secondResult = await second;
  resolver.pending[0]!.release(glb);
  const firstResult = await first;

  assert.equal(secondResult.success, true);
  assert.equal(firstResult.success, false, "the superseded attach must not install its instance");
  assert.equal(runtime.getInstance(entityId)?.assetId, "model_second");
  assert.equal(runtime.getModelMetadata(entityId)?.assetId, "model_second");
  assert.equal(runtime.instanceCount, 1);
  assert.equal(object.children.length, 1, "only the winning model scene stays attached");
});

test("attachModel: detachModel while the asset resolves cancels the pending attach", async () => {
  const resolver = new GatedResolver();
  const runtime = ThreeSceneRuntime.instantiate(projectWithModel("model_a"), sceneId);
  const object = runtime.getObject(entityId)!;

  const attaching = runtime.attachModel(entityId, "model_b", resolver);
  await resolver.until(1);
  runtime.detachModel(entityId);
  resolver.pending[0]!.release(await createSyntheticGlb({ size: [1, 1, 1] }));
  const result = await attaching;

  assert.equal(result.success, false);
  assert.equal(runtime.instanceCount, 0);
  assert.equal(object.children.length, 0);
  assert.equal(runtime.getModelMetadata(entityId)?.loaded, false);
});
