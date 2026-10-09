import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime } from "../src/index.js";

async function walkingHero(): Promise<{ runtime: ThreeSceneRuntime; hero: string; other: string }> {
  const sceneId = stableId("scene", "crossfade-guards");
  const hero = stableId("entity", "crossfade_guard_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "crossfade-guards"),
    name: "Crossfade guards",
    scenes: [
      {
        id: sceneId,
        name: "Crossfade guards",
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
  const clips = runtime.getModelMetadata(hero)!.animation!.clips.map((c) => c.name);
  const other = clips.find((name) => name !== "walk");
  assert.ok(other, `fixture needs a second clip, got ${clips.join(",")}`);
  return { runtime, hero, other };
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
  test(`crossfadeAnimation rejects blendSeconds=${bad} and leaves the current clip playing`, async () => {
    const { runtime, hero, other } = await walkingHero();
    assert.equal(runtime.crossfadeAnimation(hero, other, bad), false);
    const session = runtime.getAnimatorSession(hero)!;
    assert.equal(session.activeClipName, "walk");
    assert.equal(session.blend, undefined, "a rejected crossfade must not start a blend");
    runtime.updateAnimation(1 / 60);
    assert.ok(allFinite(runtime.getObject(hero)!));
    runtime.dispose();
  });

  test(`crossfadeAnimation rejects speed=${bad} instead of poisoning the mixer`, async () => {
    const { runtime, hero, other } = await walkingHero();
    assert.equal(runtime.crossfadeAnimation(hero, other, 0, { speed: bad }), false);
    assert.equal(runtime.playAnimation(hero, other), true);
    runtime.updateAnimation(1 / 60);
    const time = runtime.getModelMetadata(hero)!.animation!.time;
    assert.ok(Number.isFinite(time), `animation time became ${time}`);
    assert.ok(allFinite(runtime.getObject(hero)!));
    runtime.dispose();
  });
}

test("crossfadeAnimation with a finite blend still completes", async () => {
  const { runtime, hero, other } = await walkingHero();
  assert.equal(runtime.crossfadeAnimation(hero, other, 0.2), true);
  runtime.updateAnimation(0.3);
  const session = runtime.getAnimatorSession(hero)!;
  assert.equal(session.blend, undefined);
  assert.equal(session.activeClipName, other);
  runtime.dispose();
});
