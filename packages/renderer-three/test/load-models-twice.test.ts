import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { ThreeSceneRuntime, type AssetResolver } from "../src/index.js";

const sceneId = stableId("scene", "load-models-twice");
const heroId = stableId("entity", "load_models_twice_hero");

function projectDoc(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "load-models-twice"),
    name: "loadModels twice",
    scenes: [
      {
        id: sceneId,
        name: "loadModels twice",
        entities: [
          {
            id: heroId,
            name: "Hero",
            components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } },
          },
        ],
      },
    ],
  };
}

async function rig(): Promise<{ runtime: ThreeSceneRuntime; resolver: AssetResolver }> {
  const glb = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = { resolve: (id) => (id === "bot" ? glb : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(projectDoc(), sceneId, { assetResolver: resolver });
  return { runtime, resolver };
}

function modelSceneCount(runtime: ThreeSceneRuntime): number {
  const object = runtime.getObject(heroId);
  assert.ok(object, "hero object exists");
  return object.children.filter((child) => child.name.endsWith(":Model")).length;
}

test("calling loadModels again does not stack a second model scene on the entity", async () => {
  const { runtime, resolver } = await rig();
  assert.equal(modelSceneCount(runtime), 1);
  const firstInstance = runtime.getInstance(heroId);
  assert.ok(firstInstance, "first load created an instance");

  await runtime.loadModels(resolver);

  assert.equal(modelSceneCount(runtime), 1, "the entity must carry exactly one model scene");
  assert.equal(runtime.instanceCount, 1);
  assert.equal(runtime.getModelMetadata(heroId)?.loaded, true);
  // Whatever instance is kept, the other one must not stay alive holding a template reference.
  const kept = runtime.getInstance(heroId);
  assert.ok(kept);
  assert.equal(kept.template.refCount, 1, "no leaked instance keeps the template pinned");
  if (kept !== firstInstance) {
    assert.equal(firstInstance.isDisposed, true, "a replaced instance must be disposed");
  }
  runtime.dispose();
});

test("calling loadModels again keeps an animation that is already playing", async () => {
  const { runtime, resolver } = await rig();
  assert.equal(runtime.playAnimation(heroId, "walk", { loop: true }), true);
  runtime.updateAnimation(0.1);

  await runtime.loadModels(resolver);

  const animation = runtime.getModelMetadata(heroId)?.animation;
  assert.equal(animation?.activeClip, "walk");
  assert.equal(animation?.playing, true);
  runtime.updateAnimation(0.1);
  assert.ok((runtime.getModelMetadata(heroId)?.animation?.time ?? 0) > 0);
  runtime.dispose();
});
