import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime } from "../src/index.js";

async function rig(): Promise<{ runtime: ThreeSceneRuntime; hero: string; duration: number }> {
  const sceneId = stableId("scene", "crossfade-same");
  const hero = stableId("entity", "crossfade_same_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "crossfade-same"),
    name: "Crossfade same clip",
    scenes: [
      {
        id: sceneId,
        name: "Crossfade same clip",
        entities: [
          {
            id: hero,
            name: "Hero",
            components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } },
          },
        ],
      },
    ],
  };
  const glb = await createSyntheticCharacterGlb();
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, {
    assetResolver: { resolve: (id) => (id === "bot" ? glb : undefined) },
  });
  const clip = runtime.getModelMetadata(hero)?.animation?.clips.find((c) => c.name === "walk");
  assert.ok(clip && clip.duration > 0, "synthetic character needs a walk clip");
  return { runtime, hero, duration: clip.duration };
}

function step(runtime: ThreeSceneRuntime, seconds: number, dt = 1 / 30): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) runtime.updateAnimation(dt);
}

test("crossfading a clip to itself keeps it playing after the fade ends", async () => {
  const { runtime, hero } = await rig();
  runtime.registerAnimationClip(hero, new THREE.AnimationClip("extra", 2, []));
  assert.equal(runtime.playAnimation(hero, "walk", { loop: true }), true);
  step(runtime, 0.1);

  // Same clip as the one already playing (a graph self-transition, or a script re-requesting
  // the current state): the fade ends and the clip must still be alive.
  assert.equal(runtime.crossfadeAnimation(hero, "walk", 0.2, { loop: true }), true);
  step(runtime, 0.5);

  const animation = runtime.getModelMetadata(hero)?.animation;
  assert.notEqual(animation?.graph?.transitioning, true, "no fade is left running");
  assert.equal(animation?.activeClip, "walk");
  assert.equal(animation?.playing, true, "the clip was stopped when the fade ended");
  assert.deepEqual(
    animation?.actions?.map((a) => [a.clip, a.weight, a.role]),
    [["walk", 1, "active"]],
  );

  const before = animation?.time ?? 0;
  step(runtime, 0.1);
  const after = runtime.getModelMetadata(hero)?.animation?.time ?? 0;
  assert.notEqual(after, before, "animation time keeps advancing after the fade");
  runtime.dispose();
});

test("crossfading to the same clip mid-fade does not freeze the pose either", async () => {
  const { runtime, hero } = await rig();
  runtime.registerAnimationClip(hero, new THREE.AnimationClip("extra", 2, []));
  runtime.playAnimation(hero, "walk", { loop: true });
  step(runtime, 0.1);
  assert.equal(runtime.crossfadeAnimation(hero, "extra", 0.4, { loop: true }), true);
  step(runtime, 0.1);
  // Interrupt the fade towards "extra" with a fade towards the clip that is fading out.
  assert.equal(runtime.crossfadeAnimation(hero, "walk", 0.2, { loop: true }), true);
  step(runtime, 0.6);
  const animation = runtime.getModelMetadata(hero)?.animation;
  assert.equal(animation?.activeClip, "walk");
  assert.equal(animation?.playing, true);
  runtime.dispose();
});
