import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type EntityDefinition, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime } from "../src/index.js";

const sceneId = stableId("scene", "construction");

function projectWith(entities: EntityDefinition[]): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "construction"),
    name: "Construction fixture",
    scenes: [{ id: sceneId, name: "Construction", entities }],
  };
}

function entity(name: string, components: EntityDefinition["components"], parentId?: string): EntityDefinition {
  const id = stableId("entity", name);
  return { id, name, components, ...(parentId ? { parentId } : {}) } as EntityDefinition;
}

test("instantiate rejects a scene id that is not in the project", () => {
  const missing = stableId("scene", "nope");
  assert.throws(
    () => ThreeSceneRuntime.instantiate(projectWith([]), missing),
    (error: Error) => error.message.includes(missing) && error.message.includes("does not exist"),
  );
});

test("instantiateAsync rejects (never hangs) for a missing scene id", async () => {
  const missing = stableId("scene", "nope-async");
  await assert.rejects(
    () => ThreeSceneRuntime.instantiateAsync(projectWith([]), missing),
    (error: Error) => error.message.includes(missing),
  );
});

test("an unsupported Camera.type names the type and the entity", () => {
  const cam = entity("cam", { Camera: { type: "orthographic" } });
  assert.throws(
    () => ThreeSceneRuntime.instantiate(projectWith([cam]), sceneId),
    (error: Error) =>
      error.message.includes('Camera.type "orthographic"') && error.message.includes(cam.id),
  );
});

test("an unsupported Light.kind names the kind and the entity", () => {
  const light = entity("lamp", { Light: { kind: "spot" } });
  assert.throws(
    () => ThreeSceneRuntime.instantiate(projectWith([light]), sceneId),
    (error: Error) => error.message.includes('Light.kind "spot"') && error.message.includes(light.id),
  );
});

test("an unsupported Primitive.kind names the kind and the entity", () => {
  const prim = entity("blob", { Primitive: { kind: "torus" } });
  assert.throws(
    () => ThreeSceneRuntime.instantiate(projectWith([prim]), sceneId),
    (error: Error) => error.message.includes('Primitive.kind "torus"') && error.message.includes(prim.id),
  );
});

test("a parentId that points at no entity fails construction with both ids", () => {
  const ghostParent = stableId("entity", "ghost");
  const child = entity("orphan", {}, ghostParent);
  assert.throws(
    () => ThreeSceneRuntime.instantiate(projectWith([child]), sceneId),
    (error: Error) => error.message.includes(ghostParent) && error.message.includes(child.id),
  );
});

test("component defaults: camera, lights and primitives fill missing fields", () => {
  const runtime = ThreeSceneRuntime.instantiate(
    projectWith([
      entity("cam", { Camera: {} }),
      entity("light-default", { Light: {} }),
      entity("light-ambient", { Light: { kind: "ambient", intensity: 0.25 } }),
      entity("light-point", { Light: { kind: "point", color: "#ff0000" } }),
      entity("prim-default", { Primitive: {} }),
      entity("prim-sphere", { Primitive: { kind: "sphere", segments: 2 } }),
      entity("plain", {}),
    ]),
    sceneId,
  );

  const cam = runtime.getObject(stableId("entity", "cam")) as THREE.PerspectiveCamera;
  assert.ok(cam instanceof THREE.PerspectiveCamera);
  assert.equal(cam.fov, 60);
  assert.equal(cam.near, 0.1);
  assert.equal(cam.far, 2000);

  assert.ok(runtime.getObject(stableId("entity", "light-default")) instanceof THREE.DirectionalLight);
  const ambient = runtime.getObject(stableId("entity", "light-ambient")) as THREE.AmbientLight;
  assert.ok(ambient instanceof THREE.AmbientLight);
  assert.equal(ambient.intensity, 0.25);
  const point = runtime.getObject(stableId("entity", "light-point")) as THREE.PointLight;
  assert.ok(point instanceof THREE.PointLight);
  assert.equal(point.color.getHexString(), "ff0000");

  const box = runtime.getObject(stableId("entity", "prim-default")) as THREE.Mesh;
  assert.ok(box.geometry instanceof THREE.BoxGeometry);

  // Sphere tessellation is clamped to at least 8 segments.
  const sphere = runtime.getObject(stableId("entity", "prim-sphere")) as THREE.Mesh;
  assert.ok(sphere.geometry instanceof THREE.SphereGeometry);
  assert.equal((sphere.geometry as THREE.SphereGeometry).parameters.widthSegments, 8);

  assert.ok(runtime.getObject(stableId("entity", "plain")) instanceof THREE.Group);
  runtime.dispose();
});

test("loadModels on a disposed runtime rejects instead of loading into torn-down state", async () => {
  const runtime = ThreeSceneRuntime.instantiate(projectWith([entity("a", {})]), sceneId);
  runtime.dispose();
  await assert.rejects(
    () => runtime.loadModels({ resolve: () => undefined }),
    (error: Error) => error.message.includes("disposed"),
  );
  assert.equal(runtime.models().size, 0);
});
