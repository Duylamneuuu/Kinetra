import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime } from "../src/index.js";

async function walkingHero(): Promise<{ runtime: ThreeSceneRuntime; hero: string }> {
  const sceneId = stableId("scene", "step-guards");
  const hero = stableId("entity", "step_guard_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "step-guards"),
    name: "Step guards",
    scenes: [
      {
        id: sceneId,
        name: "Step guards",
        entities: [{ id: hero, name: "Hero", components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } } }],
      },
    ],
  };
  const glb = await createSyntheticCharacterGlb();
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, {
    assetResolver: { resolve: (id) => (id === "bot" ? glb : undefined) },
  });
  assert.equal(runtime.playAnimation(hero, "walk", { loop: true }), true);
  runtime.updateAnimation(0.1);
  return { runtime, hero };
}

function allFinite(object: THREE.Object3D): boolean {
  let ok = true;
  object.traverse((child) => {
    for (const v of [...child.position.toArray(), ...child.quaternion.toArray(), ...child.scale.toArray()]) {
      if (!Number.isFinite(v)) ok = false;
    }
  });
  return ok;
}

for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`updateAnimation(${bad}) is ignored instead of poisoning clip time and bone transforms`, async () => {
    const { runtime, hero } = await walkingHero();
    const before = runtime.getModelMetadata(hero)!.animation!.time;
    runtime.updateAnimation(bad);
    const after = runtime.getModelMetadata(hero)!.animation!.time;
    assert.ok(Number.isFinite(after), `animation time became ${after}`);
    assert.equal(after, before);
    // A later good step must still animate normally.
    runtime.updateAnimation(1 / 60);
    assert.ok(Number.isFinite(runtime.getModelMetadata(hero)!.animation!.time));
    assert.ok(allFinite(runtime.getObject(hero)!), "a bone transform became non-finite");
    runtime.dispose();
  });
}

test("sampleRootMotion ignores a non-finite delta", async () => {
  const { runtime, hero } = await walkingHero();
  const delta = runtime.sampleRootMotion(hero, Number.NaN);
  assert.deepEqual(delta, { translation: [0, 0, 0], yaw: 0 });
  runtime.dispose();
});
