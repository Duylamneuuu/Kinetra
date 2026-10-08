import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { createSyntheticGlb, createSyntheticMorphGlb } from "@kinetra/asset-pipeline";
import * as THREE from "three";

import { ThreeSceneRuntime, type AssetResolver } from "../src/index.js";

const sceneId = stableId("scene", "morph-test");
const headA = stableId("entity", "head_a");
const headB = stableId("entity", "head_b");
const crate = stableId("entity", "crate");
const empty = stableId("entity", "empty");
const ASSET_HEAD = "asset_morph_head";
const ASSET_CRATE = "asset_crate";

class MemoryAssetResolver implements AssetResolver {
  readonly assets = new Map<string, Uint8Array>();
  readonly fingerprints = new Map<string, string>();
  set(assetId: string, bytes: Uint8Array, fingerprint: string): void {
    this.assets.set(assetId, bytes);
    this.fingerprints.set(assetId, fingerprint);
  }
  resolve(assetId: string): Uint8Array | undefined {
    return this.assets.get(assetId);
  }
  getFingerprint(assetId: string): string | undefined {
    return this.fingerprints.get(assetId);
  }
}

function project(): ProjectDocument {
  const entity = (id: string, name: string, x: number, assetId?: string) => ({
    id,
    name,
    components: {
      Transform: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ...(assetId ? { Model: { assetId } } : {}),
    },
  });
  return {
    schemaVersion: 1,
    projectId: stableId("project", "morph-test"),
    name: "Morph Fixture",
    scenes: [
      {
        id: sceneId,
        name: "MorphScene",
        entities: [
          entity(headA, "HeadA", -2, ASSET_HEAD),
          entity(headB, "HeadB", 2, ASSET_HEAD),
          entity(crate, "Crate", 0, ASSET_CRATE),
          entity(empty, "Empty", 4),
        ],
      },
    ],
  } as ProjectDocument;
}

async function start(
  options: Parameters<typeof createSyntheticMorphGlb>[0] = {},
): Promise<{ runtime: ThreeSceneRuntime; resolver: MemoryAssetResolver }> {
  const resolver = new MemoryAssetResolver();
  resolver.set(ASSET_HEAD, await createSyntheticMorphGlb(options), "fp_head_v1");
  resolver.set(ASSET_CRATE, await createSyntheticGlb({ size: [1, 1, 1] }), "fp_crate_v1");
  const runtime = await ThreeSceneRuntime.instantiateAsync(project(), sceneId, {
    assetResolver: resolver,
  });
  return { runtime, resolver };
}

type MorphMesh = THREE.Mesh & { morphTargetInfluences: number[] };

function meshNamed(runtime: ThreeSceneRuntime, entityId: string, name: string): MorphMesh {
  let found: MorphMesh | undefined;
  runtime.getObject(entityId)!.traverse((child) => {
    const mesh = child as MorphMesh;
    if (mesh.isMesh && child.name === name && Array.isArray(mesh.morphTargetInfluences)) {
      found = mesh;
    }
  });
  assert.ok(found, `mesh ${name} on ${entityId}`);
  return found;
}

function weight(runtime: ThreeSceneRuntime, entityId: string, name: string): number | undefined {
  return runtime
    .getModelMetadata(entityId)
    ?.morphTargets?.targets.find((t) => t.name === name)?.weight;
}

test("morph runtime: catalog is observed from the loaded glTF with authored defaults", async () => {
  const { runtime } = await start({ faceWeights: [0.25, 0], browWeights: [0, 0.5] });
  try {
    const morph = runtime.getModelMetadata(headA)?.morphTargets;
    assert.ok(morph, "morph targets must be observable");
    assert.deepEqual(morph.overrides, {});
    assert.deepEqual(morph.targets, [
      { name: "blink", weight: 0, meshes: ["Face", "Brow"], overridden: false },
      { name: "raise", weight: 0.5, meshes: ["Brow"], overridden: false },
      { name: "smile", weight: 0.25, meshes: ["Face"], overridden: false },
    ]);
    assert.equal(runtime.getModelMetadata(crate)?.morphTargets, undefined);
    assert.equal(runtime.getMorphTargetController(crate), undefined);
  } finally {
    runtime.dispose();
  }
});

test("morph runtime: setMorphWeights drives shared names on every mesh and isolates instances", async () => {
  const { runtime } = await start();
  try {
    const result = runtime.setMorphWeights(headA, { blink: 0.8, smile: 0.4 });
    assert.equal(result.success, true);
    assert.deepEqual(result.applied, [
      { name: "blink", weight: 0.8 },
      { name: "smile", weight: 0.4 },
    ]);

    const faceA = meshNamed(runtime, headA, "Face");
    const browA = meshNamed(runtime, headA, "Brow");
    assert.ok(Math.abs(faceA.morphTargetInfluences[1]! - 0.8) < 1e-6);
    assert.ok(Math.abs(faceA.morphTargetInfluences[0]! - 0.4) < 1e-6);
    assert.ok(Math.abs(browA.morphTargetInfluences[0]! - 0.8) < 1e-6);
    assert.equal(browA.morphTargetInfluences[1], 0);

    // The second instance of the same template must not change.
    const faceB = meshNamed(runtime, headB, "Face");
    assert.notEqual(faceA.morphTargetInfluences, faceB.morphTargetInfluences);
    assert.deepEqual(faceB.morphTargetInfluences, [0, 0]);
    assert.deepEqual(runtime.getModelMetadata(headB)?.morphTargets?.overrides, {});

    const observed = runtime.getModelMetadata(headA)?.morphTargets;
    assert.deepEqual(observed?.overrides, { blink: 0.8, smile: 0.4 });
    assert.equal(observed?.targets.find((t) => t.name === "raise")?.overridden, false);
    assert.equal(observed?.targets.find((t) => t.name === "blink")?.overridden, true);
  } finally {
    runtime.dispose();
  }
});

test("morph runtime: invalid requests are rejected whole and leave the mesh untouched", async () => {
  const { runtime } = await start();
  try {
    const face = meshNamed(runtime, headA, "Face");
    const result = runtime.setMorphWeights(headA, { smile: 0.5, frown: 1 });
    assert.equal(result.success, false);
    assert.deepEqual(result.diagnostics?.map((d) => d.code), ["anim.morph.unknownTarget"]);
    assert.match(result.error ?? "", /anim\.morph\.unknownTarget/);
    assert.deepEqual(face.morphTargetInfluences, [0, 0]);
    assert.deepEqual(runtime.getModelMetadata(headA)?.morphTargets?.overrides, {});

    const outOfRange = runtime.setMorphWeights(headA, { smile: 2 });
    assert.equal(outOfRange.diagnostics?.[0]?.code, "anim.morph.weightOutOfRange");
    const malformed = runtime.setMorphWeights(headA, "smile");
    assert.equal(malformed.diagnostics?.[0]?.code, "anim.morph.invalidRequest");
    const badClear = runtime.clearMorphWeights(headA, ["frown"]);
    assert.equal(badClear.success, false);
    assert.equal(badClear.diagnostics?.[0]?.code, "anim.morph.unknownTarget");
  } finally {
    runtime.dispose();
  }
});

test("morph runtime: entity errors carry structured diagnostics", async () => {
  const { runtime } = await start();
  try {
    assert.equal(runtime.setMorphWeights(crate, { smile: 1 }).diagnostics?.[0]?.code, "anim.morph.noTargets");
    assert.equal(runtime.setMorphWeights(empty, { smile: 1 }).diagnostics?.[0]?.code, "anim.morph.noModel");
    assert.equal(runtime.setMorphWeights("missing", { smile: 1 }).diagnostics?.[0]?.code, "anim.morph.noModel");
    assert.equal(runtime.clearMorphWeights(crate).diagnostics?.[0]?.code, "anim.morph.noTargets");
  } finally {
    runtime.dispose();
  }
  const after = runtime.setMorphWeights(headA, { smile: 1 });
  assert.equal(after.success, false);
  assert.equal(after.diagnostics?.[0]?.code, "anim.morph.runtimeDisposed");
});

test("morph runtime: clear restores authored defaults, selectively or entirely", async () => {
  const { runtime } = await start({ faceWeights: [0.25, 0], browWeights: [0, 0.5] });
  try {
    runtime.setMorphWeights(headA, { smile: 1, blink: 1, raise: 0 });
    const partial = runtime.clearMorphWeights(headA, ["smile", "smile"]);
    assert.deepEqual(partial, { success: true, cleared: ["smile"] });
    assert.equal(weight(runtime, headA, "smile"), 0.25);
    assert.deepEqual(runtime.getModelMetadata(headA)?.morphTargets?.overrides, { blink: 1, raise: 0 });

    const rest = runtime.clearMorphWeights(headA);
    assert.deepEqual(rest, { success: true, cleared: ["blink", "raise"] });
    const face = meshNamed(runtime, headA, "Face");
    const brow = meshNamed(runtime, headA, "Brow");
    assert.deepEqual(face.morphTargetInfluences, [0.25, 0]);
    assert.deepEqual(brow.morphTargetInfluences, [0, 0.5]);

    // Clearing a name that has no override is a successful no-op.
    assert.deepEqual(runtime.clearMorphWeights(headA, ["smile"]), { success: true, cleared: [] });
    assert.deepEqual(runtime.clearMorphWeights(headA), { success: true, cleared: [] });
  } finally {
    runtime.dispose();
  }
});

test("morph runtime: clip tracks animate weights and runtime overrides win over them", async () => {
  const { runtime } = await start({ blinkDuration: 1 });
  try {
    assert.equal(runtime.playAnimation(headA, "Blink", { loop: true }), true);
    runtime.updateAnimation(0.5);
    const animated = weight(runtime, headA, "blink");
    assert.ok(animated !== undefined && Math.abs(animated - 1) < 1e-3, `clip drives blink, got ${animated}`);

    runtime.setMorphWeights(headA, { blink: 0.2 });
    runtime.updateAnimation(0.25);
    const face = meshNamed(runtime, headA, "Face");
    assert.ok(Math.abs(face.morphTargetInfluences[1]! - 0.2) < 1e-6, "override must win over the clip");
    assert.ok(Math.abs(weight(runtime, headA, "blink")! - 0.2) < 1e-6);

    runtime.clearMorphWeights(headA, ["blink"]);
    runtime.updateAnimation(0.25);
    const resumed = face.morphTargetInfluences[1]!;
    assert.ok(Math.abs(resumed - 0) < 1e-3, `clip owns blink again after clear, got ${resumed}`);
  } finally {
    runtime.dispose();
  }
});

test("morph runtime: reload keeps surviving overrides and reports dropped targets", async () => {
  const { runtime, resolver } = await start();
  try {
    runtime.setMorphWeights(headA, { smile: 0.6, raise: 0.9 });
    resolver.set(ASSET_HEAD, await createSyntheticMorphGlb({ faceWeights: [0.1, 0] }), "fp_head_v2");
    const same = await runtime.reloadAsset(ASSET_HEAD, resolver);
    assert.equal(same.success, true);
    assert.equal(same.droppedMorphOverrides, undefined);
    assert.deepEqual(runtime.getModelMetadata(headA)?.morphTargets?.overrides, { raise: 0.9, smile: 0.6 });
    assert.ok(Math.abs(meshNamed(runtime, headA, "Face").morphTargetInfluences[0]! - 0.6) < 1e-6);
    // Instance B had no overrides and picks up the new authored default.
    assert.ok(Math.abs(weight(runtime, headB, "smile")! - 0.1) < 1e-6);

    // Swap the asset for one with no morph targets at all.
    resolver.set(ASSET_HEAD, await createSyntheticGlb({ size: [1, 1, 1] }), "fp_head_v3");
    const dropped = await runtime.reloadAsset(ASSET_HEAD, resolver);
    assert.equal(dropped.success, true);
    assert.deepEqual(dropped.droppedMorphOverrides, { [headA]: ["raise", "smile"] });
    assert.equal(runtime.getModelMetadata(headA)?.morphTargets, undefined);
    assert.equal(runtime.setMorphWeights(headA, { smile: 1 }).diagnostics?.[0]?.code, "anim.morph.noTargets");
  } finally {
    runtime.dispose();
  }
});
