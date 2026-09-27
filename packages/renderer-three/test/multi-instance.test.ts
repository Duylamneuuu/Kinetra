import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import * as THREE from "three";

import {
  ThreeSceneRuntime,
  ModelAssetTemplate,
  ModelTemplateCache,
  type AssetResolver,
} from "../src/index.js";

const sceneId = stableId("scene", "multi-instance");
const enemyAId = stableId("entity", "enemy_a");
const enemyBId = stableId("entity", "enemy_b");
const enemyCId = stableId("entity", "enemy_c");
const ASSET_ENEMY_BOT = "asset_character_enemy_bot";

function createTwoEnemyProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "multi-instance"),
    name: "Multi-instance fixture",
    scenes: [
      {
        id: sceneId,
        name: "MultiInstanceScene",
        entities: [
          {
            id: enemyAId,
            name: "EnemyA",
            components: {
              Transform: { position: [-2, 0, 0] },
              Model: { assetId: ASSET_ENEMY_BOT },
            },
          },
          {
            id: enemyBId,
            name: "EnemyB",
            components: {
              Transform: { position: [2, 0, 0] },
              Model: { assetId: ASSET_ENEMY_BOT },
            },
          },
          {
            id: enemyCId,
            name: "EnemyC",
            components: {
              Transform: { position: [0, 0, 3] },
            },
          },
        ],
      },
    ],
  };
}

test("ModelAssetTemplate refcount lifecycle: 0 -> 1 -> 2 -> 1 -> 2 -> 1 -> 0 -> dispose", async () => {
  const glbBytes = await createSyntheticCharacterGlb();
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(glbBytes.buffer as ArrayBuffer, "");

  const template = new ModelAssetTemplate(ASSET_ENEMY_BOT, "tmpl_enemy", gltf);


  // 0 -> load template
  assert.equal(template.refCount, 0);
  assert.equal(template.isDisposed, false);
  assert.ok(template.sharedGeometries.size > 0);

  // 1 -> A
  const instA = template.createInstance("entity_a");
  assert.equal(template.refCount, 1);
  assert.equal(instA.isDisposed, false);
  assert.equal(instA.entityId, "entity_a");

  // 2 -> B
  const instB = template.createInstance("entity_b");
  assert.equal(template.refCount, 2);
  assert.equal(instB.isDisposed, false);
  assert.equal(instB.entityId, "entity_b");

  // Verify skeleton and bone independence
  assert.notEqual(instA.instanceId, instB.instanceId);
  const skelA = Array.from(instA.skeletons)[0]!;
  const skelB = Array.from(instB.skeletons)[0]!;
  assert.ok(skelA && skelB);
  assert.notEqual(skelA, skelB, "Instance A and Instance B must have distinct Skeletons");
  assert.notEqual(skelA.bones[0], skelB.bones[0], "Instance A and B must have independent Bones");

  // 1 -> dispose A
  instA.dispose();
  assert.equal(instA.isDisposed, true);
  assert.equal(template.refCount, 1);
  assert.equal(template.isDisposed, false, "Template must remain alive while B is active");
  assert.ok(template.sharedGeometries.size > 0, "Shared geometry must not be disposed while refCount > 0");

  // 2 -> create C
  const instC = template.createInstance("entity_c");
  assert.equal(template.refCount, 2);
  assert.equal(instC.isDisposed, false);

  // 1 -> dispose B
  instB.dispose();
  assert.equal(instB.isDisposed, true);
  assert.equal(template.refCount, 1);
  assert.equal(template.isDisposed, false);

  // 0 -> dispose C -> triggers shared resource dispose
  instC.dispose();
  assert.equal(instC.isDisposed, true);
  assert.equal(template.refCount, 0);
  assert.equal(template.isDisposed, true, "Template must be disposed when final instance is released");
  assert.equal(template.sharedGeometries.size, 0, "Shared geometries must be cleaned up");

  // Disposal is idempotent
  instC.dispose();
  template.dispose();
  assert.equal(template.refCount, 0, "RefCount must not become negative");
  assert.equal(template.isDisposed, true);
});

test("ThreeSceneRuntime concurrent load deduplication creates single parsed template for multiple entities", async () => {
  const glbBytes = await createSyntheticCharacterGlb();
  let resolveCount = 0;
  const resolver: AssetResolver = {
    resolve(assetId: string) {
      if (assetId === ASSET_ENEMY_BOT) {
        resolveCount++;
        return glbBytes;
      }
      return undefined;
    },
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(createTwoEnemyProject(), sceneId, {
    assetResolver: resolver,
  });

  // Both EnemyA and EnemyB requested ASSET_ENEMY_BOT
  assert.equal(runtime.assetTemplateParseCount, 1, "GLB must be parsed exactly once for both entities");
  assert.equal(runtime.instanceCount, 2, "Two active instances must exist");

  const metaA = runtime.getModelMetadata(enemyAId)!;
  const metaB = runtime.getModelMetadata(enemyBId)!;

  assert.ok(metaA && metaA.loaded, "EnemyA model must be loaded");
  assert.ok(metaB && metaB.loaded, "EnemyB model must be loaded");

  // Structured instance metadata
  assert.ok(metaA.instance, "EnemyA must have instance metadata");
  assert.ok(metaB.instance, "EnemyB must have instance metadata");
  assert.equal(metaA.instance.assetId, ASSET_ENEMY_BOT);
  assert.equal(metaB.instance.assetId, ASSET_ENEMY_BOT);
  assert.equal(metaA.instance.sharedTemplateId, metaB.instance.sharedTemplateId);
  assert.notEqual(metaA.instance.instanceId, metaB.instance.instanceId);

  // Resource sharing refcount
  assert.equal(metaA.resourceSharing?.templateRefCount, 2);
  assert.equal(metaB.resourceSharing?.templateRefCount, 2);

  // Skeletons and mixers are independent
  const instA = runtime.getInstance(enemyAId)!;
  const instB = runtime.getInstance(enemyBId)!;
  assert.ok(instA && instB);

  const skelA = Array.from(instA.skeletons)[0]!;
  const skelB = Array.from(instB.skeletons)[0]!;
  assert.notEqual(skelA, skelB, "Skeletons must be independent");
  assert.notEqual(skelA.bones[0], skelB.bones[0], "Bones must be independent");

  const sessionA = runtime.getAnimatorSession(enemyAId)!;
  const sessionB = runtime.getAnimatorSession(enemyBId)!;
  assert.notEqual(sessionA.mixer, sessionB.mixer, "Mixers must be independent");

  runtime.dispose();
});

test("Independent animation: EnemyA plays walk while EnemyB plays idle without bone contamination", async () => {
  const glbBytes = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = {
    resolve: (id) => (id === ASSET_ENEMY_BOT ? glbBytes : undefined),
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(createTwoEnemyProject(), sceneId, {
    assetResolver: resolver,
  });

  // Play walk on A, idle on B
  assert.equal(runtime.playAnimation(enemyAId, "walk"), true);
  assert.equal(runtime.playAnimation(enemyBId, "idle"), true);

  // Advance simulation deterministically
  runtime.updateAnimation(0.5);

  const instA = runtime.getInstance(enemyAId)!;
  const instB = runtime.getInstance(enemyBId)!;

  let legA: THREE.Bone | undefined;
  let legB: THREE.Bone | undefined;
  instA.scene.traverse((n) => {
    if (n instanceof THREE.Bone && n.name === "LeftLeg") legA = n;
  });
  instB.scene.traverse((n) => {
    if (n instanceof THREE.Bone && n.name === "LeftLeg") legB = n;
  });

  assert.ok(legA && legB, "LeftLeg bone must exist in both instances");
  assert.notDeepEqual(
    legA.quaternion.toArray(),
    legB.quaternion.toArray(),
    "EnemyA LeftLeg must have distinct rotation from EnemyB LeftLeg",
  );

  const metaA = runtime.getModelMetadata(enemyAId)!;
  const metaB = runtime.getModelMetadata(enemyBId)!;
  assert.equal(metaA.animation?.activeClip, "walk");
  assert.equal(metaB.animation?.activeClip, "idle");
  assert.equal(metaA.animation?.playing, true);
  assert.equal(metaB.animation?.playing, true);

  // Now switch EnemyB to attack, EnemyA remains on walk
  assert.equal(runtime.playAnimation(enemyBId, "attack"), true);
  runtime.updateAnimation(0.2);

  assert.equal(runtime.getModelMetadata(enemyAId)?.animation?.activeClip, "walk");
  assert.equal(runtime.getModelMetadata(enemyBId)?.animation?.activeClip, "attack");

  runtime.dispose();
});

test("Partial disposal: detaching EnemyA leaves EnemyB fully functional with decremented refCount", async () => {
  const glbBytes = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = {
    resolve: (id) => (id === ASSET_ENEMY_BOT ? glbBytes : undefined),
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(createTwoEnemyProject(), sceneId, {
    assetResolver: resolver,
  });

  assert.equal(runtime.playAnimation(enemyAId, "walk"), true);
  assert.equal(runtime.playAnimation(enemyBId, "idle"), true);
  runtime.updateAnimation(0.2);

  assert.equal(runtime.getModelMetadata(enemyBId)?.resourceSharing?.templateRefCount, 2);

  // Detach EnemyA
  const detachRes = runtime.detachModel(enemyAId);
  assert.equal(detachRes.success, true);
  assert.equal(runtime.instanceCount, 1);

  // EnemyA is unloaded
  const metaA = runtime.getModelMetadata(enemyAId)!;
  assert.equal(metaA.loaded, false);
  assert.equal(metaA.instance, undefined);

  // EnemyB remains fully functional with refCount = 1
  const metaB = runtime.getModelMetadata(enemyBId)!;
  assert.equal(metaB.loaded, true);
  assert.equal(metaB.resourceSharing?.templateRefCount, 1);

  // EnemyB can still step, animate, and transition
  runtime.updateAnimation(0.3);
  assert.equal(metaB.animation?.playing, true);
  assert.ok((metaB.animation?.time ?? 0) > 0.4);

  // Reload/attach EnemyC from same asset
  const attachRes = await runtime.attachModel(enemyCId, ASSET_ENEMY_BOT, resolver);
  assert.equal(attachRes.success, true);
  assert.equal(runtime.instanceCount, 2);

  // Template was reused without reparsing!
  assert.equal(runtime.assetTemplateParseCount, 1);

  // Both B and C now show refCount = 2
  assert.equal(runtime.getModelMetadata(enemyBId)?.resourceSharing?.templateRefCount, 2);
  assert.equal(runtime.getModelMetadata(enemyCId)?.resourceSharing?.templateRefCount, 2);

  // EnemyC has distinct skeleton from EnemyB
  const instB = runtime.getInstance(enemyBId)!;
  const instC = runtime.getInstance(enemyCId)!;
  const skelB = Array.from(instB.skeletons)[0]!;
  const skelC = Array.from(instC.skeletons)[0]!;
  assert.notEqual(skelB, skelC);

  // Clean disposal
  runtime.dispose();
  assert.equal(runtime.instanceCount, 0);
  assert.equal(runtime.disposed, true);
});

test("Retargeted clip sharing: same baked clip registered on two entities plays with independent actions", async () => {
  const glbBytes = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = {
    resolve: (id) => (id === ASSET_ENEMY_BOT ? glbBytes : undefined),
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(createTwoEnemyProject(), sceneId, {
    assetResolver: resolver,
  });

  // Create synthetic external retargeted clip
  const track = new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 0, 1, 0]);
  const sharedClip = new THREE.AnimationClip("shared_retargeted_jump", 1.0, [track]);

  runtime.registerAnimationClip(enemyAId, sharedClip);
  runtime.registerAnimationClip(enemyBId, sharedClip);

  assert.equal(runtime.playAnimation(enemyAId, "shared_retargeted_jump", { loop: false }), true);
  // Step only A by 0.5s via stepping runtime while B is not playing it yet
  runtime.updateAnimation(0.5);

  const sessionA = runtime.getAnimatorSession(enemyAId)!;
  assert.equal(sessionA.activeClipName, "shared_retargeted_jump");
  assert.ok(Math.abs((sessionA.activeAction?.time ?? 0) - 0.5) < 0.05);

  // Now play on B
  assert.equal(runtime.playAnimation(enemyBId, "shared_retargeted_jump", { loop: false }), true);
  runtime.updateAnimation(0.2);

  const sessionB = runtime.getAnimatorSession(enemyBId)!;
  // A should be at ~0.7s, B should be at ~0.2s
  assert.ok(Math.abs((sessionA.activeAction?.time ?? 0) - 0.7) < 0.05);
  assert.ok(Math.abs((sessionB.activeAction?.time ?? 0) - 0.2) < 0.05);

  runtime.dispose();
});

test("Failure isolation: invalid animation request on EnemyA does not affect EnemyB", async () => {
  const glbBytes = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = {
    resolve: (id) => (id === ASSET_ENEMY_BOT ? glbBytes : undefined),
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(createTwoEnemyProject(), sceneId, {
    assetResolver: resolver,
  });

  assert.equal(runtime.playAnimation(enemyBId, "idle"), true);

  // Invalid clip on EnemyA returns false
  assert.equal(runtime.playAnimation(enemyAId, "non_existent_clip"), false);

  // EnemyB continues playing cleanly
  runtime.updateAnimation(0.1);
  const metaB = runtime.getModelMetadata(enemyBId)!;
  assert.equal(metaB.animation?.activeClip, "idle");
  assert.equal(metaB.animation?.playing, true);

  runtime.dispose();
});

