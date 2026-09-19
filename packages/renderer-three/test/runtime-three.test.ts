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

