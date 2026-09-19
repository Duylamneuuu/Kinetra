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
