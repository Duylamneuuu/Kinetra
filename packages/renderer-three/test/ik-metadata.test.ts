import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { createSyntheticCharacterGlb, createSyntheticPropGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ThreeSceneRuntime } from "../src/index.js";

// Review follow-up #82 item 1: `IkController.observe()` (reachable / converged / error per chain) was
// never written into `ModelMetadata`, so `runtime.query()` / MCP could not tell whether IK converged.

async function boot(assetId: "bot" | "crate") {
  const sceneId = stableId("scene", "ik-meta");
  const hero = stableId("entity", "ik_meta_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "ik-meta"),
    name: "IK metadata",
    scenes: [
      {
        id: sceneId,
        name: "IK metadata",
        entities: [{ id: hero, name: "Hero", components: { Transform: { position: [0, 0, 0] }, Model: { assetId } } }],
      },
    ],
  };
  const glb = assetId === "bot" ? await createSyntheticCharacterGlb() : await createSyntheticPropGlb({ name: "Crate" });
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, {
    assetResolver: { resolve: (id) => (id === assetId ? glb : undefined) },
  });
  return { runtime, hero };
}

const spine = { schemaVersion: 1 as const, id: "spine", solver: "two-bone" as const, joints: ["Hips", "Spine", "Head"] };

test("a model without IK chains publishes no metadata.ik", async () => {
  const { runtime, hero } = await boot("bot");
  assert.equal(runtime.getModelMetadata(hero)?.ik, undefined);
  runtime.dispose();
});

test("metadata.ik lists the registered chains and the solver outcome after a frame", async () => {
  const { runtime, hero } = await boot("bot");
  runtime.setIkChains(hero, [spine]);
  assert.deepEqual(runtime.getModelMetadata(hero)?.ik, { chains: ["spine"], targets: [] });

  assert.equal(runtime.setIkTarget(hero, "spine", [0.4, 1.2, 0.2], { pole: [0, 1, 2] }).success, true);
  runtime.updateAnimation(1 / 60);
  const ik = runtime.getModelMetadata(hero)?.ik;
  assert.ok(ik, "metadata.ik is published");
  assert.deepEqual(ik.chains, ["spine"]);
  assert.equal(ik.targets.length, 1);
  assert.equal(ik.targets[0]!.chainId, "spine");
  assert.deepEqual(ik.targets[0]!.target, [0.4, 1.2, 0.2]);
  assert.equal(ik.targets[0]!.reachable, true);
  assert.equal(ik.targets[0]!.converged, true);
  assert.ok(ik.targets[0]!.error < 1e-3, `error ${ik.targets[0]!.error}`);

  // An out-of-reach target is observable as unreachable instead of looking like success.
  runtime.setIkTarget(hero, "spine", [50, 50, 50]);
  runtime.updateAnimation(1 / 60);
  assert.equal(runtime.getModelMetadata(hero)?.ik?.targets[0]!.reachable, false);
  runtime.dispose();
});

test("clearing the target removes it from metadata.ik, and clearing every chain drops the field", async () => {
  const { runtime, hero } = await boot("bot");
  runtime.setIkChains(hero, [spine]);
  runtime.setIkTarget(hero, "spine", [0.4, 1.2, 0.2], { pole: [0, 1, 2] });
  runtime.updateAnimation(1 / 60);
  runtime.clearIkTarget(hero, "spine");
  assert.deepEqual(runtime.getModelMetadata(hero)?.ik, { chains: ["spine"], targets: [] });
  runtime.dispose();
});

test("metadata.ik is a copy: editing it does not move the stored target", async () => {
  const { runtime, hero } = await boot("bot");
  runtime.setIkChains(hero, [spine]);
  runtime.setIkTarget(hero, "spine", [0.4, 1.2, 0.2], { pole: [0, 1, 2] });
  runtime.updateAnimation(1 / 60);
  const ik = runtime.getModelMetadata(hero)!.ik!;
  (ik.targets[0]!.target as number[])[0] = 99;
  assert.deepEqual(runtime.getIkController(hero)!.observe()[0]!.target, [0.4, 1.2, 0.2]);
  runtime.dispose();
});

test("metadata.ik is published for a model without clips as well", async () => {
  const { runtime, hero } = await boot("crate");
  const object = runtime.getObject(hero)!;
  const frame = object.getObjectByName("Crate_Frame")!;
  frame.position.set(1, 0, 0);
  const tip = new THREE.Object3D();
  tip.name = "Crate_Tip";
  tip.position.set(1, 0, 0);
  frame.add(tip);
  object.updateMatrixWorld(true);
  runtime.setIkChains(hero, [
    { schemaVersion: 1, id: "lid", solver: "two-bone", joints: ["Crate_Root", "Crate_Frame", "Crate_Tip"] },
    { schemaVersion: 1, id: "ghost", solver: "two-bone", joints: ["Nope", "Missing", "Gone"] },
  ]);
  // The rejected chain is not advertised as registered.
  assert.deepEqual(runtime.getModelMetadata(hero)?.ik?.chains, ["lid"]);
  runtime.setIkTarget(hero, "lid", [1, 1, 0], { pole: [0, 0, 1] });
  runtime.updateAnimation(1 / 60);
  const observed = runtime.getModelMetadata(hero)?.ik?.targets[0];
  assert.equal(observed?.chainId, "lid");
  assert.equal(observed?.converged, true);
  runtime.dispose();
});
