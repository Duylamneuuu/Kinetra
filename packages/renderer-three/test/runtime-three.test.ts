import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime } from "../src/index.js";

const sceneId = stableId("scene", "runtime");
const rootId = stableId("entity", "root");
const cameraId = stableId("entity", "camera");
const lightId = stableId("entity", "light");
const boxId = stableId("entity", "box");
const sphereId = stableId("entity", "sphere");
const planeId = stableId("entity", "plane");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "runtime"),
    name: "Runtime fixture",
    scenes: [
      {
        id: sceneId,
        name: "Runtime",
        entities: [
          {
            id: rootId,
            name: "Root",
            components: {
              Transform: { position: [4, 5, 6], rotation: [0, 0.5, 0], scale: [2, 2, 2] },
              Model: { assetId: "asset_hero" },
            },
          },
          {
            id: cameraId,
            name: "Camera",
            parentId: rootId,
            components: {
              Transform: { position: [0, 2, 5] },
              Camera: { type: "perspective", fov: 70, near: 0.2, far: 1000 },
            },
          },
          {
            id: lightId,
            name: "Sun",
            components: {
              Light: { kind: "directional", color: "#ffffff", intensity: 3 },
            },
          },
          {
            id: boxId,
            name: "Box",
            components: {
              Transform: { position: [0, 0.5, 0] },
              Primitive: { kind: "box", size: [1, 1, 1], color: "#ff8800" },
            },
          },
          {
            id: sphereId,
            name: "Sphere",
            components: {
              Transform: { position: [2, 0.5, 0] },
              Primitive: { kind: "sphere", radius: 0.5, segments: 16, color: "#00ff88" },
            },
          },
          {
            id: planeId,
            name: "Floor",
            components: {
              Transform: { position: [0, 0, 0] },
              Primitive: { kind: "plane", width: 10, height: 10, color: "#333333" },
            },
          },
        ],
      },
    ],
  };
}

test("instantiates project data into Three.js runtime objects", () => {
  const runtime = ThreeSceneRuntime.instantiate(project(), sceneId);

  const root = runtime.getObject(rootId);
  const camera = runtime.getObject(cameraId);
  const light = runtime.getObject(lightId);
  const box = runtime.getObject(boxId);
  const sphere = runtime.getObject(sphereId);
  const plane = runtime.getObject(planeId);

  assert.ok(root instanceof THREE.Group);
  assert.ok(camera instanceof THREE.PerspectiveCamera);
  assert.ok(light instanceof THREE.DirectionalLight);
  assert.ok(box instanceof THREE.Mesh);
  assert.ok(sphere instanceof THREE.Mesh);
  assert.ok(plane instanceof THREE.Mesh);

  assert.ok(box.geometry instanceof THREE.BoxGeometry);
  assert.ok(sphere.geometry instanceof THREE.SphereGeometry);
  assert.ok(plane.geometry instanceof THREE.PlaneGeometry);

  assert.equal(camera.parent, root);
  assert.deepEqual(root.position.toArray(), [4, 5, 6]);
  assert.deepEqual(root.scale.toArray(), [2, 2, 2]);
  assert.deepEqual(root.userData.kinetraModel, { assetId: "asset_hero" });
  assert.equal(runtime.scene.children.includes(root), true);
  assert.equal(runtime.scene.children.includes(light), true);
  assert.equal(runtime.scene.children.includes(box), true);
});

test("dispose tears down runtime projection deterministically", () => {
  const runtime = ThreeSceneRuntime.instantiate(project(), sceneId);
  assert.equal(runtime.objects().size, 6);

  const box = runtime.getObject(boxId) as THREE.Mesh;
  let disposedGeometry = false;
  box.geometry.dispose = () => {
    disposedGeometry = true;
  };

  runtime.dispose();

  assert.equal(disposedGeometry, true);
  assert.equal(runtime.disposed, true);
  assert.equal(runtime.objects().size, 0);
  assert.equal(runtime.scene.children.length, 0);

  runtime.dispose();
  assert.equal(runtime.scene.children.length, 0);
});

test("loads GLTF model via AssetResolver and exposes metadata with proper disposal", async () => {
  const { createSyntheticGlb } = await import("@kinetra/asset-pipeline");
  const glbBytes = await createSyntheticGlb({
    meshName: "HeroMesh",
    nodeName: "HeroNode",
    materialName: "HeroMat",
    size: [1, 2, 3],
  });

  const resolver = {
    resolve(assetId: string) {
      if (assetId === "asset_hero") {
        return glbBytes;
      }
      return undefined;
    },
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(project(), sceneId, {
    assetResolver: resolver,
  });

  const metadata = runtime.getModelMetadata(rootId);
  assert.ok(metadata);
  assert.equal(metadata.assetId, "asset_hero");
  assert.equal(metadata.loaded, true);
  assert.equal(metadata.meshCount, 1);
  assert.ok(metadata.nodeCount >= 1);
  assert.ok(metadata.bounds);
  assert.deepEqual(metadata.bounds.size, [1, 2, 3]);

  const root = runtime.getObject(rootId)!;
  const child = root.children.find((c) => c.name === "Root:Model");
  assert.ok(child);

  runtime.dispose();
  assert.equal(runtime.disposed, true);
  assert.equal(runtime.models().size, 0);
});

test("handles unresolvable assetId with structured error metadata", async () => {
  const resolver = {
    resolve() {
      return undefined;
    },
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(project(), sceneId, {
    assetResolver: resolver,
  });

  const metadata = runtime.getModelMetadata(rootId);
  assert.ok(metadata);
  assert.equal(metadata.loaded, false);
  assert.ok(metadata.error?.includes("asset_hero"));

  runtime.dispose();
});

test("loads animated GLTF, discovers clips, plays, deterministically advances, stops, and handles invalid clips", async () => {
  const { createSyntheticAnimatedGlb } = await import("@kinetra/asset-pipeline");
  const glbBytes = await createSyntheticAnimatedGlb({
    meshName: "HeroMesh",
    nodeName: "AnimatedBoxNode",
    clipName: "MoveX",
    duration: 1.0,
    from: [0, 0, 0],
    to: [1, 0, 0],
  });

  const resolver = {
    resolve(assetId: string) {
      if (assetId === "asset_hero") {
        return glbBytes;
      }
      return undefined;
    },
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(project(), sceneId, {
    assetResolver: resolver,
  });

  const metadata = runtime.getModelMetadata(rootId);
  assert.ok(metadata);
  assert.equal(metadata.loaded, true);
  assert.ok(metadata.animation);
  assert.equal(metadata.animation.clips.length, 1);
  assert.equal(metadata.animation.clips[0]!.name, "MoveX");
  assert.equal(metadata.animation.clips[0]!.duration, 1.0);
  assert.equal(metadata.animation.playing, false);

  // Missing clip returns false
  const invalidResult = runtime.playAnimation(rootId, "DOES_NOT_EXIST");
  assert.equal(invalidResult, false);
  assert.equal(metadata.animation.playing, false);

  // Valid clip starts
  const playResult = runtime.playAnimation(rootId, "MoveX", { loop: false });
  assert.equal(playResult, true);
  assert.equal(metadata.animation.playing, true);
  assert.equal(metadata.animation.activeClip, "MoveX");

  // Initial node position
  const initialNode = metadata.nodes?.find((n) => n.name === "AnimatedBoxNode");
  assert.ok(initialNode);
  assert.equal(initialNode.position[0], 0);

  // Step 0.5s
  runtime.updateAnimation(0.5);
  assert.equal(metadata.animation.time, 0.5);
  assert.equal(metadata.animation.playing, true);
  const midNode = metadata.nodes?.find((n) => n.name === "AnimatedBoxNode");
  assert.ok(midNode);
  assert.ok(Math.abs(midNode.position[0] - 0.5) < 0.001);

  // Step another 0.5s -> reaches end
  runtime.updateAnimation(0.5);
  assert.equal(metadata.animation.time, 1.0);
  const endNode = metadata.nodes?.find((n) => n.name === "AnimatedBoxNode");
  assert.ok(endNode);
  assert.ok(Math.abs(endNode.position[0] - 1.0) < 0.001);

  // Stop animation
  runtime.stopAnimation(rootId);
  assert.equal(metadata.animation.playing, false);

  // Dispose cleanly
  runtime.dispose();
  assert.equal(runtime.disposed, true);
});

test("crossfadeAnimation shifts weights deterministically and cleans outgoing action on completion", async () => {
  const { createSyntheticAnimatedGlb } = await import("@kinetra/asset-pipeline");
  const glbBytes = await createSyntheticAnimatedGlb({
    meshName: "HeroMesh",
    nodeName: "AnimatedBoxNode",
    clipName: "ClipA",
    duration: 1.0,
    from: [0, 0, 0],
    to: [1, 0, 0],
  });

  const resolver = {
    resolve(assetId: string) {
      if (assetId === "asset_hero") return glbBytes;
      return undefined;
    },
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(project(), sceneId, {
    assetResolver: resolver,
  });

  // Register a second clip
  const track = new THREE.VectorKeyframeTrack("AnimatedBoxNode.position", [0, 1], [0, 0, 0, 0, 1, 0]);
  const clipB = new THREE.AnimationClip("ClipB", 1.0, [track]);
  runtime.registerAnimationClip(rootId, clipB);

  // Start with ClipA
  const ok1 = runtime.playAnimation(rootId, "ClipA");
  assert.equal(ok1, true);

  const meta = runtime.getModelMetadata(rootId)!;
  assert.equal(meta.animation?.activeClip, "ClipA");
  assert.deepEqual(meta.animation?.actions, [
    { clip: "ClipA", weight: 1.0, role: "active" },
  ]);

  // Start crossfade to ClipB with blendSeconds = 0.20s
  const ok2 = runtime.crossfadeAnimation(rootId, "ClipB", 0.20);
  assert.equal(ok2, true);

  // Immediately at start of blend (time 0)
  assert.equal(meta.animation?.graph?.transitioning, true);
  assert.equal(meta.animation?.graph?.blendProgress, 0);
  assert.equal(meta.animation?.actions?.length, 2);
  const outAction0 = meta.animation?.actions?.find((a) => a.role === "outgoing");
  const inAction0 = meta.animation?.actions?.find((a) => a.role === "incoming");
  assert.equal(outAction0?.clip, "ClipA");
  assert.equal(outAction0?.weight, 1.0);
  assert.equal(inAction0?.clip, "ClipB");
  assert.equal(inAction0?.weight, 0.0);

  // Step 0.10s (halfway through 0.20s blend)
  runtime.updateAnimation(0.10);
  assert.equal(meta.animation?.graph?.transitioning, true);
  assert.ok(Math.abs((meta.animation?.graph?.blendProgress ?? 0) - 0.5) < 0.001);
  const outActionMid = meta.animation?.actions?.find((a) => a.role === "outgoing");
  const inActionMid = meta.animation?.actions?.find((a) => a.role === "incoming");
  assert.ok(Math.abs((outActionMid?.weight ?? 0) - 0.5) < 0.001);
  assert.ok(Math.abs((inActionMid?.weight ?? 0) - 0.5) < 0.001);

  // Step another 0.10s (blend completes at 0.20s)
  runtime.updateAnimation(0.10);
  assert.equal(meta.animation?.graph?.transitioning, false);
  assert.equal(meta.animation?.graph?.blendProgress, 1.0);
  assert.equal(meta.animation?.activeClip, "ClipB");
  assert.deepEqual(meta.animation?.actions, [
    { clip: "ClipB", weight: 1.0, role: "active" },
  ]);

  runtime.dispose();
});

test("crossfadeAnimation handles mid-blend interruption cleanly without action leakage", async () => {
  const { createSyntheticAnimatedGlb } = await import("@kinetra/asset-pipeline");
  const glbBytes = await createSyntheticAnimatedGlb({
    meshName: "HeroMesh",
    nodeName: "AnimatedBoxNode",
    clipName: "Walk",
    duration: 1.0,
    from: [0, 0, 0],
    to: [1, 0, 0],
  });

  const resolver = {
    resolve(assetId: string) {
      if (assetId === "asset_hero") return glbBytes;
      return undefined;
    },
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(project(), sceneId, {
    assetResolver: resolver,
  });

  // Register Telegraph and Hurt clips
  const track1 = new THREE.VectorKeyframeTrack("AnimatedBoxNode.position", [0, 1], [0, 0, 0, 0, 1, 0]);
  const clipTelegraph = new THREE.AnimationClip("Telegraph", 1.0, [track1]);
  runtime.registerAnimationClip(rootId, clipTelegraph);

  const track2 = new THREE.VectorKeyframeTrack("AnimatedBoxNode.position", [0, 1], [0, 0, 0, 0, 0, 1]);
  const clipHurt = new THREE.AnimationClip("Hurt", 0.5, [track2]);
  runtime.registerAnimationClip(rootId, clipHurt);

  // Start in Walk
  runtime.playAnimation(rootId, "Walk");

  // Begin blend Walk -> Telegraph over 0.20s
  runtime.crossfadeAnimation(rootId, "Telegraph", 0.20);
  runtime.updateAnimation(0.10); // 50% through blend

  const meta = runtime.getModelMetadata(rootId)!;
  assert.equal(meta.animation?.actions?.length, 2);

  // Interrupt with Hurt over 0.10s!
  runtime.crossfadeAnimation(rootId, "Hurt", 0.10);

  // Walk must be stopped; only Telegraph (outgoing) and Hurt (incoming) remain
  assert.equal(meta.animation?.actions?.length, 2);
  const outAction = meta.animation?.actions?.find((a) => a.role === "outgoing");
  const inAction = meta.animation?.actions?.find((a) => a.role === "incoming");
  assert.equal(outAction?.clip, "Telegraph");
  assert.equal(inAction?.clip, "Hurt");

  // Step 0.10s to complete the Hurt blend
  runtime.updateAnimation(0.10);
  assert.equal(meta.animation?.graph?.transitioning, false);
  assert.equal(meta.animation?.activeClip, "Hurt");
  assert.deepEqual(meta.animation?.actions, [
    { clip: "Hurt", weight: 1.0, role: "active" },
  ]);

  runtime.dispose();
});

test("AnimationGraph drives runtime playback, parameters, and triggers with structured errors for invalid inputs", async () => {
  const { createSyntheticAnimatedGlb } = await import("@kinetra/asset-pipeline");
  const glbBytes = await createSyntheticAnimatedGlb({
    meshName: "HeroMesh",
    nodeName: "AnimatedBoxNode",
    clipName: "idle",
    duration: 1.0,
    from: [0, 0, 0],
    to: [0, 0, 0],
  });

  const resolver = {
    resolve(assetId: string) {
      if (assetId === "asset_hero") return glbBytes;
      return undefined;
    },
  };

  const runtime = await ThreeSceneRuntime.instantiateAsync(project(), sceneId, {
    assetResolver: resolver,
  });

  // Register walk and attack clips
  const track = new THREE.VectorKeyframeTrack("AnimatedBoxNode.position", [0, 1], [0, 0, 0, 1, 0, 0]);
  runtime.registerAnimationClip(rootId, new THREE.AnimationClip("walk", 1.0, [track]));
  runtime.registerAnimationClip(rootId, new THREE.AnimationClip("attack", 0.5, [track]));

  const graphDef = {
    schemaVersion: 1 as const,
    entryState: "idle",
    parameters: {
      moving: { type: "bool" as const, default: false },
      attackTrigger: { type: "trigger" as const },
    },
    states: [
      { id: "idle", clipId: "idle", loop: true },
      { id: "walk", clipId: "walk", loop: true },
      { id: "attack", clipId: "attack", loop: false },
    ],
    transitions: [
      {
        id: "t_walk",
        from: "idle",
        to: "walk",
        blendSeconds: 0.20,
        conditions: [{ parameter: "moving", op: "==" as const, value: true }],
      },
      {
        id: "t_attack",
        from: "walk",
        to: "attack",
        blendSeconds: 0.10,
        priority: 10,
        conditions: [{ parameter: "attackTrigger", op: "triggered" as const }],
      },
      {
        id: "t_stop",
        from: "walk",
        to: "idle",
        blendSeconds: 0.15,
        conditions: [{ parameter: "moving", op: "==" as const, value: false }],
      },
    ],
  };

  // Rejection when graph references unknown clip
  const badGraph = structuredClone(graphDef);
  badGraph.states[0]!.clipId = "unknown_clip_123";
  const badInit = runtime.initAnimationGraph(rootId, badGraph);
  assert.equal(badInit.success, false);
  assert.ok(badInit.diagnostics?.some((d) => d.code === "anim.state.clip.unknown"));

  // Valid init starts in entry state
  const initRes = runtime.initAnimationGraph(rootId, graphDef);
  assert.equal(initRes.success, true);

  const meta = runtime.getModelMetadata(rootId)!;
  assert.equal(meta.animation?.activeClip, "idle");
  assert.equal(meta.animation?.graph?.state, "idle");
  assert.equal(meta.animation?.graph?.transitioning, false);

  // Setting unknown parameter returns structured error
  const badParamRes = runtime.setAnimationGraphParameter(rootId, "non_existent", true);
  assert.equal(badParamRes.success, false);
  assert.ok(badParamRes.error?.includes("Unknown animation parameter"));

  // Setting wrong parameter type returns structured error
  const wrongTypeRes = runtime.setAnimationGraphParameter(rootId, "moving", 123);
  assert.equal(wrongTypeRes.success, false);
  assert.ok(wrongTypeRes.error?.includes("expects boolean"));

  // Valid parameter update causes transition
  const setRes = runtime.setAnimationGraphParameter(rootId, "moving", true);
  assert.equal(setRes.success, true);
  assert.equal(setRes.transition?.to, "walk");
  assert.equal(meta.animation?.graph?.state, "walk");
  assert.equal(meta.animation?.graph?.transitioning, true);

  // Complete walk blend
  runtime.updateAnimation(0.20);
  assert.equal(meta.animation?.graph?.transitioning, false);
  assert.equal(meta.animation?.activeClip, "walk");

  // Trigger attack
  const trigRes = runtime.triggerAnimationGraph(rootId, "attackTrigger");
  assert.equal(trigRes.success, true);
  assert.equal(trigRes.transition?.to, "attack");
  assert.equal(meta.animation?.graph?.state, "attack");
  assert.equal(meta.animation?.graph?.transitioning, true);

  // Complete attack blend
  runtime.updateAnimation(0.10);
  assert.equal(meta.animation?.graph?.transitioning, false);
  assert.equal(meta.animation?.activeClip, "attack");

  runtime.dispose();
});

