import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime } from "../src/index.js";

async function rig(): Promise<{ runtime: ThreeSceneRuntime; hero: string }> {
  const sceneId = stableId("scene", "rm-loop-mode");
  const hero = stableId("entity", "rm_loop_mode_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "rm-loop-mode"),
    name: "Root motion keeps loop mode",
    scenes: [
      {
        id: sceneId,
        name: "Root motion keeps loop mode",
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
  // The synthetic walk clip has no root-bone translation track, so root motion could not be
  // extracted from it; give the entity a clip that travels along X.
  runtime.registerAnimationClip(
    hero,
    new THREE.AnimationClip("stride", 1, [
      new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 0.9, 0, 1, 0.9, 0]),
    ]),
  );
  return { runtime, hero };
}

test("enabling root motion while a one-shot clip plays keeps it a one-shot clip", async () => {
  const { runtime, hero } = await rig();
  assert.equal(runtime.playAnimation(hero, "stride", { loop: false }), true);
  runtime.updateAnimation(0.05);
  const before = runtime.getAnimatorSession(hero)?.activeAction;
  assert.equal(before?.loop, THREE.LoopOnce, "precondition: the clip plays once");

  const result = runtime.configureRootMotion(hero, { enabled: true, mode: "extract-xz", rootBoneName: "Hips" });
  assert.equal(result.success, true, result.error);

  const session = runtime.getAnimatorSession(hero);
  assert.ok(session?.rootMotion?.extracted, "root motion was extracted from the playing clip");
  const after = session?.activeAction;
  assert.ok(after, "the clip is still playing");
  assert.equal(after.loop, THREE.LoopOnce, "the in-place replacement must keep the one-shot loop mode");
  assert.equal(after.clampWhenFinished, true, "and hold its last pose when it finishes");
  runtime.dispose();
});

test("enabling root motion keeps a playing clip's speed, weight and time", async () => {
  const { runtime, hero } = await rig();
  assert.equal(runtime.crossfadeAnimation(hero, "stride", 0, { loop: true, speed: 2 }), true);
  runtime.updateAnimation(0.1);
  const timeBefore = runtime.getAnimatorSession(hero)?.activeAction?.time ?? 0;

  const result = runtime.configureRootMotion(hero, { enabled: true, mode: "extract-xz", rootBoneName: "Hips" });
  assert.equal(result.success, true, result.error);

  const action = runtime.getAnimatorSession(hero)?.activeAction;
  assert.ok(action);
  assert.equal(action.loop, THREE.LoopRepeat);
  assert.equal(action.getEffectiveTimeScale(), 2);
  assert.equal(action.getEffectiveWeight(), 1);
  assert.ok(Math.abs(action.time - timeBefore) < 1e-9);
  runtime.dispose();
});
