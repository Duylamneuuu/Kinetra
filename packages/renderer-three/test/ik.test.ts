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
  ]);
  assert.deepEqual(ik.chainIds, ["arm"]);
  const codes = ik.registrationDiagnostics.map((d) => d.code);
  assert.ok(codes.includes("ik.chain.duplicate"));
  assert.ok(codes.includes("ik.chain.missing-bone"));
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

import { createSyntheticCharacterGlb, createSyntheticPropGlb } from "@kinetra/asset-pipeline";
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

test("partial-weight IK does not compound across frames when nothing rewrites the pose", () => {
  const root = arm();
  const ik = new IkController(root, [twoBone]);
  ik.setTarget("arm", [0.5, 1.2, 0], { pole: [0, 0, 1], weight: 0.5 });
  ik.apply();
  const first = handPos(root).clone();
  for (let i = 0; i < 5; i++) ik.apply();
  const later = handPos(root);
  assert.ok(later.distanceTo(first) < 1e-6, `hand drifted from ${first.toArray()} to ${later.toArray()}`);
});

test("clearTarget restores the input pose when no animation rewrites the bones", () => {
  const root = arm();
  const before = handPos(root).clone();
  const ik = new IkController(root, [twoBone]);
  ik.setTarget("arm", [0.5, 1.2, 0], { pole: [0, 0, 1] });
  ik.apply();
  assert.ok(handPos(root).distanceTo(before) > 0.1);
  ik.clearTarget("arm");
  assert.ok(handPos(root).distanceTo(before) < 1e-6, `hand stayed at ${handPos(root).toArray()}`);
});

test("IK leaves a bone alone when animation rewrote it since the last solve", () => {
  const root = arm();
  const ik = new IkController(root, [twoBone]);
  ik.setTarget("arm", [0.5, 1.2, 0], { pole: [0, 0, 1], weight: 0.5 });
  ik.apply();
  const first = handPos(root).clone();
  // Simulate mixer.update writing the animated (rest) pose back.
  for (const name of ["upper", "lower", "hand"]) root.getObjectByName(name)!.quaternion.identity();
  ik.apply();
  assert.ok(handPos(root).distanceTo(first) < 1e-6);
});

test("chains apply in chain-id order regardless of setTarget order", () => {
  const build = (order: string[]) => {
    const root = arm();
    const ik = new IkController(root, [
      { schemaVersion: 1, id: "a-upper", solver: "fabrik", joints: ["upper", "lower"] },
      { schemaVersion: 1, id: "b-full", solver: "fabrik", joints: ["upper", "lower", "hand"] },
    ]);
    const targets: Record<string, [number, number, number]> = { "a-upper": [0, 1, 0], "b-full": [1, 1, 0.5] };
    for (const id of order) ik.setTarget(id, targets[id]!);
    ik.apply();
    return handPos(root);
  };
  const ab = build(["a-upper", "b-full"]);
  const ba = build(["b-full", "a-upper"]);
  assert.ok(ab.distanceTo(ba) < 1e-9, `${ab.toArray()} vs ${ba.toArray()}`);
});

test("runtime keeps partial-weight IK stable across frames", async () => {
  const sceneId = stableId("scene", "ik-stable");
  const hero = stableId("entity", "ik_stable_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "ik-stable"),
    name: "IK stable",
    scenes: [
      {
        id: sceneId,
        name: "IK stable",
        entities: [{ id: hero, name: "Hero", components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } } }],
      },
    ],
  };
  const glb = await createSyntheticCharacterGlb();
  const resolver = { resolve: (id: string) => (id === "bot" ? glb : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, { assetResolver: resolver });
  runtime.setIkChains(hero, [{ schemaVersion: 1, id: "spine", solver: "two-bone", joints: ["Hips", "Spine", "Head"] }]);
  assert.equal(runtime.setIkTarget(hero, "spine", [0.4, 1.2, 0.2], { pole: [0, 1, 2], weight: 0.5 }).success, true);
  const headPos = () => runtime.getObject(hero)!.getObjectByName("Head")!.getWorldPosition(new THREE.Vector3());
  runtime.updateAnimation(1 / 60);
  const first = headPos().clone();
  runtime.updateAnimation(1 / 60);
  runtime.updateAnimation(1 / 60);
  assert.ok(headPos().distanceTo(first) < 1e-6, `head drifted from ${first.toArray()} to ${headPos().toArray()}`);
  runtime.dispose();
});

test("runtime applies IK to a model without animation clips", async () => {
  const sceneId = stableId("scene", "ik-static");
  const prop = stableId("entity", "ik_static_prop");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "ik-static"),
    name: "IK static",
    scenes: [
      {
        id: sceneId,
        name: "IK static",
        entities: [{ id: prop, name: "Prop", components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "crate" } } }],
      },
    ],
  };
  const glb = await createSyntheticPropGlb({ name: "Crate" });
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, {
    assetResolver: { resolve: (id) => (id === "crate" ? glb : undefined) },
  });
  const object = runtime.getObject(prop)!;
  // Give the static hierarchy a three-joint chain: Root -> Frame (+1 x) -> Tip (+1 x).
  const frame = object.getObjectByName("Crate_Frame")!;
  frame.position.set(1, 0, 0);
  const tip = new THREE.Object3D();
  tip.name = "Crate_Tip";
  tip.position.set(1, 0, 0);
  frame.add(tip);
  object.updateMatrixWorld(true);
  const controller = runtime.setIkChains(prop, [
    { schemaVersion: 1, id: "lid", solver: "two-bone", joints: ["Crate_Root", "Crate_Frame", "Crate_Tip"] },
  ]);
  assert.deepEqual(controller?.chainIds, ["lid"]);
  assert.equal(runtime.setIkTarget(prop, "lid", [1, 1, 0], { pole: [0, 0, 1] }).success, true);
  runtime.updateAnimation(1 / 60);
  const p = tip.getWorldPosition(new THREE.Vector3());
  assert.ok(p.distanceTo(new THREE.Vector3(1, 1, 0)) < 1e-4, `tip at ${p.toArray()}`);
  runtime.dispose();
});

test("replacing IK chains un-bends bones the previous chains posed", () => {
  const root = arm();
  const before = handPos(root).clone();
  const first = new IkController(root, [twoBone]);
  first.setTarget("arm", [0.5, 1.2, 0], { pole: [0, 0, 1] });
  first.apply();
  first.clearTarget();
  assert.ok(handPos(root).distanceTo(before) < 1e-6);
});
