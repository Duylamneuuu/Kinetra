import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime } from "../src/index.js";

async function rig(): Promise<{ runtime: ThreeSceneRuntime; hero: string }> {
  const sceneId = stableId("scene", "rm-invalid-root");
  const hero = stableId("entity", "rm_invalid_root_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "rm-invalid-root"),
    name: "Root motion invalid root",
    scenes: [
      {
        id: sceneId,
        name: "Root motion invalid root",
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
  runtime.registerAnimationClip(
    hero,
    new THREE.AnimationClip("stride", 1, [
      new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 0.9, 0, 1, 0.9, 0]),
    ]),
  );
  return { runtime, hero };
}

test("a root bone that is not in the model is refused with a structured diagnostic", async () => {
  const { runtime, hero } = await rig();
  const result = runtime.configureRootMotion(hero, {
    enabled: true,
    mode: "extract-xz",
    rootBoneName: "NoSuchBone",
  });
  assert.equal(result.success, false);
  assert.equal(result.diagnostics?.code, "animation.rootMotion.invalidRoot");
  assert.ok(result.error?.includes("NoSuchBone"), "the message names the missing bone");
  assert.ok(result.error?.includes(hero), "and the entity");
  assert.ok(result.diagnostics?.hint, "the diagnostic carries a hint");
  runtime.dispose();
});

test("a refused root motion request leaves the playing clip untouched", async () => {
  const { runtime, hero } = await rig();
  assert.equal(runtime.playAnimation(hero, "stride", { loop: true }), true);
  runtime.updateAnimation(0.1);
  const before = runtime.getAnimatorSession(hero)?.activeAction;
  assert.ok(before, "precondition: the clip is playing");

  const result = runtime.configureRootMotion(hero, { enabled: true, rootBoneName: "NoSuchBone" });
  assert.equal(result.success, false);

  const session = runtime.getAnimatorSession(hero);
  assert.equal(session?.activeAction, before, "the same action keeps playing");
  assert.equal(session?.rootMotion?.extracted, undefined, "nothing was extracted");
  runtime.dispose();
});

test("disabling root motion succeeds even when no root motion was ever enabled", async () => {
  const { runtime, hero } = await rig();
  const result = runtime.configureRootMotion(hero, { enabled: false });
  assert.equal(result.success, true, result.error);
  runtime.dispose();
});

test("the default root bone is Hips, and a valid request after a refused one succeeds", async () => {
  const { runtime, hero } = await rig();
  assert.equal(runtime.playAnimation(hero, "stride", { loop: true }), true);
  runtime.updateAnimation(0.05);
  assert.equal(runtime.configureRootMotion(hero, { enabled: true, rootBoneName: "Nope" }).success, false);
  const ok = runtime.configureRootMotion(hero, { enabled: true });
  assert.equal(ok.success, true, ok.error);
  assert.ok(runtime.getAnimatorSession(hero)?.rootMotion?.extracted, "extracted from the default Hips bone");
  runtime.dispose();
});
