import assert from "node:assert/strict";
import test from "node:test";

import type { IkChainDefinition } from "@kinetra/animation/ik";
import * as THREE from "three";

import { IkController } from "../src/ik.js";

function arm(): THREE.Object3D {
  const root = new THREE.Group();
  const upper = new THREE.Bone();
  upper.name = "upper";
  const lower = new THREE.Bone();
  lower.name = "lower";
  lower.position.set(1, 0, 0);
  const hand = new THREE.Bone();
  hand.name = "hand";
  hand.position.set(1, 0, 0);
  root.add(upper);
  upper.add(lower);
  lower.add(hand);
  root.updateMatrixWorld(true);
  return root;
}

const twoBone: IkChainDefinition = { schemaVersion: 1, id: "arm", solver: "two-bone", joints: ["upper", "lower", "hand"] };
const fabrik: IkChainDefinition = { schemaVersion: 1, id: "arm-f", solver: "fabrik", joints: ["upper", "lower", "hand"] };

function handPos(root: THREE.Object3D): THREE.Vector3 {
  root.updateMatrixWorld(true);
  return root.getObjectByName("hand")!.getWorldPosition(new THREE.Vector3());
}

test("two-bone IK moves the hand onto a reachable target", () => {
  const root = arm();
  const ik = new IkController(root, [twoBone]);
  assert.deepEqual(ik.chainIds, ["arm"]);
  assert.equal(ik.setTarget("arm", [1, 1, 0], { pole: [0, 0, 1] }).success, true);
  ik.apply();
  assert.ok(handPos(root).distanceTo(new THREE.Vector3(1, 1, 0)) < 1e-4);
  const obs = ik.observe();
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.reachable, true);
});

test("fabrik IK converges and bone lengths are preserved", () => {
  const root = arm();
  const ik = new IkController(root, [fabrik]);
  ik.setTarget("arm-f", [0.5, 1.2, 0.3]);
  ik.apply();
  const lower = root.getObjectByName("lower")!.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(lower.length() - 1) < 1e-4);
  assert.ok(handPos(root).distanceTo(new THREE.Vector3(0.5, 1.2, 0.3)) < 1e-3);
});

test("unreachable target stretches towards it and reports not reachable", () => {
  const root = arm();
  const ik = new IkController(root, [twoBone]);
  ik.setTarget("arm", [0, 5, 0]);
  ik.apply();
  assert.equal(ik.observe()[0]!.reachable, false);
  const h = handPos(root);
  assert.ok(h.y > 1.9 && Math.abs(h.length() - 2) < 1e-3);
});

test("weight 0 keeps the animated pose", () => {
  const root = arm();
  const ik = new IkController(root, [twoBone]);
  ik.setTarget("arm", [0, 1, 0], { weight: 0 });
  ik.apply();
  assert.ok(handPos(root).distanceTo(new THREE.Vector3(2, 0, 0)) < 1e-4);
});

test("bad input yields structured diagnostics instead of throwing", () => {
  const root = arm();
  const ik = new IkController(root, [
    twoBone,
    twoBone,
    { ...twoBone, id: "ghost", joints: ["upper", "lower", "nope"] },
    { ...twoBone, id: "bad", joints: ["upper"] },
    null as never,
    [] as never,
  ]);
  assert.deepEqual(ik.chainIds, ["arm"]);
  const codes = ik.registrationDiagnostics.map((d) => d.code);
  assert.ok(codes.includes("ik.chain.duplicate"));
  assert.ok(codes.includes("ik.chain.missing-bone"));
  assert.equal(codes.filter((c) => c === "ik.chain.invalid").length, 2);
  assert.ok(ik.registrationDiagnostics.length >= 3);
  assert.equal(ik.setTarget("zzz", [0, 0, 0]).diagnostics[0]!.code, "ik.target.unknown-chain");
  assert.equal(ik.setTarget("arm", [0, NaN, 0]).diagnostics[0]!.code, "ik.target.invalid");
  assert.equal(ik.setTarget("arm", "x").success, false);
  assert.equal(ik.setTarget("arm", [0, 1, 0], { weight: 2 }).diagnostics[0]!.code, "ik.target.invalid-weight");
  assert.equal(ik.setTarget("arm", [0, 1, 0], { pole: [1, 2] as never }).diagnostics[0]!.code, "ik.target.invalid-pole");
  assert.equal(ik.activeCount, 0);
});

test("clearTarget stops applying IK", () => {
  const root = arm();
  const ik = new IkController(root, [twoBone]);
  ik.setTarget("arm", [1, 1, 0]);
  ik.clearTarget("arm");
  assert.equal(ik.activeCount, 0);
  ik.apply();
  assert.deepEqual(ik.observe(), []);
});

test("works under a rotated and offset parent", () => {
  const root = arm();
  root.position.set(3, 1, -2);
  root.rotation.set(0.4, 1.1, -0.3);
  root.updateMatrixWorld(true);
  const ik = new IkController(root, [twoBone]);
  const target = new THREE.Vector3(3.2, 2.1, -1.5);
  ik.setTarget("arm", [target.x, target.y, target.z]);
  ik.apply();
  assert.ok(handPos(root).distanceTo(target) < 1e-4);
});

import { createSyntheticCharacterGlb, createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ThreeSceneRuntime } from "../src/index.js";

test("runtime applies IK after updateAnimation on a real glTF skeleton", async () => {
  const sceneId = stableId("scene", "ik");
  const hero = stableId("entity", "ik_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "ik"),
    name: "IK",
    scenes: [
      {
        id: sceneId,
        name: "IK",
        entities: [{ id: hero, name: "Hero", components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } } }],
      },
    ],
  };
  const glb = await createSyntheticCharacterGlb();
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, {
    assetResolver: { resolve: (id) => (id === "bot" ? glb : undefined) },
  });
  assert.equal(runtime.setIkTarget(hero, "spine", [0, 0, 0]).diagnostics[0]!.code, "ik.runtime.no-chains");
  const controller = runtime.setIkChains(hero, [
    { schemaVersion: 1, id: "spine", solver: "two-bone", joints: ["Hips", "Spine", "Head"] },
  ]);
  assert.deepEqual(controller?.chainIds, ["spine"]);
  const result = runtime.setIkTarget(hero, "spine", [0.4, 1.2, 0.2], { pole: [0, 1, 2] });
  assert.equal(result.success, true);
  runtime.updateAnimation(1 / 60);
  const head = runtime.getObject(hero)!.getObjectByName("Head")!;
  const p = head.getWorldPosition(new THREE.Vector3());
  assert.ok(p.distanceTo(new THREE.Vector3(0.4, 1.2, 0.2)) < 1e-3, `head at ${p.toArray()}`);
  runtime.dispose();
  assert.equal(runtime.setIkChains(hero, []), undefined);
});

function ikDoc(): { doc: ProjectDocument; hero: string; sceneId: string } {
  const sceneId = stableId("scene", "ik_reload");
  const hero = stableId("entity", "ik_reload_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "ik_reload"),
    name: "IK reload",
    scenes: [
      {
        id: sceneId,
        name: "IK reload",
        entities: [{ id: hero, name: "Hero", components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } } }],
      },
    ],
  };
  return { doc, hero, sceneId };
}

const spineChain: IkChainDefinition = { schemaVersion: 1, id: "spine", solver: "two-bone", joints: ["Hips", "Spine", "Head"] };
const spineTarget = new THREE.Vector3(0.4, 1.2, 0.2);

function headPos(runtime: ThreeSceneRuntime, hero: string): THREE.Vector3 {
  return runtime.getObject(hero)!.getObjectByName("Head")!.getWorldPosition(new THREE.Vector3());
}

test("IK chains and targets are re-bound to the new bones after a hot reimport", async () => {
  const { doc, hero, sceneId } = ikDoc();
  const glb = await createSyntheticCharacterGlb();
  const resolver = { resolve: (id: string) => (id === "bot" ? glb : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, { assetResolver: resolver });
  runtime.setIkChains(hero, [spineChain]);
  assert.equal(runtime.setIkTarget(hero, "spine", spineTarget.toArray(), { pole: [0, 1, 2] }).success, true);
  const before = runtime.getIkController(hero);

  const reload = await runtime.reloadAsset("bot", resolver);
  assert.equal(reload.success, true);
  assert.equal(reload.droppedIkChains, undefined);
  const after = runtime.getIkController(hero);
  assert.ok(after && after !== before, "a fresh controller must be bound to the reloaded instance");
  assert.deepEqual(after.chainIds, ["spine"]);
  assert.equal(after.activeCount, 1);

  runtime.updateAnimation(1 / 60);
  const p = headPos(runtime, hero);
  assert.ok(p.distanceTo(spineTarget) < 1e-3, `head must follow the IK target after reload, got ${p.toArray()}`);
  runtime.dispose();
});

test("hot reimport into an asset without the chain bones drops and reports the IK chain", async () => {
  const { doc, hero, sceneId } = ikDoc();
  const character = await createSyntheticCharacterGlb();
  const box = await createSyntheticGlb();
  let current: Uint8Array = character;
  const resolver = { resolve: (id: string) => (id === "bot" ? current : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, { assetResolver: resolver });
  runtime.setIkChains(hero, [spineChain]);
  runtime.setIkTarget(hero, "spine", spineTarget.toArray());

  current = box;
  const reload = await runtime.reloadAsset("bot", resolver);
  assert.equal(reload.success, true);
  assert.deepEqual(reload.droppedIkChains, { [hero]: ["spine"] });
  const controller = runtime.getIkController(hero)!;
  assert.deepEqual(controller.chainIds, []);
  assert.ok(controller.registrationDiagnostics.some((d) => d.code === "ik.chain.missing-bone"));
  assert.equal(controller.activeCount, 0);
  runtime.updateAnimation(1 / 60);
  runtime.dispose();
});
