import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { ThreeSceneRuntime } from "../src/index.js";

const sceneId = stableId("scene", "non-finite");
const entityId = stableId("entity", "thing");

function project(transform: Record<string, unknown>, primitive?: Record<string, unknown>): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "non-finite"),
    name: "Non finite",
    scenes: [
      {
        id: sceneId,
        name: "Scene",
        entities: [
          {
            id: entityId,
            name: "Thing",
            components: {
              Transform: transform,
              ...(primitive ? { Primitive: primitive } : {}),
            },
          },
        ],
      },
    ],
  } as unknown as ProjectDocument;
}

test("Transform vectors with NaN/Infinity entries fall back to the defaults instead of poisoning the object", () => {
  const runtime = ThreeSceneRuntime.instantiate(
    project({
      position: [Number.NaN, 1, 2],
      rotation: [0, Number.POSITIVE_INFINITY, 0],
      scale: [1, 1, Number.NEGATIVE_INFINITY],
    }),
    sceneId,
  );
  const object = runtime.getObject(entityId)!;

  assert.deepEqual(object.position.toArray(), [0, 0, 0]);
  assert.deepEqual([object.rotation.x, object.rotation.y, object.rotation.z], [0, 0, 0]);
  assert.deepEqual(object.scale.toArray(), [1, 1, 1]);
  runtime.dispose();
});

test("Primitive.size with a non-finite entry falls back to the default box instead of a NaN geometry", () => {
  const runtime = ThreeSceneRuntime.instantiate(
    project({}, { kind: "box", size: [Number.NaN, 1, 1] }),
    sceneId,
  );
  const object = runtime.getObject(entityId) as unknown as {
    geometry: { parameters: { width: number; height: number; depth: number } };
  };

  assert.deepEqual(
    [object.geometry.parameters.width, object.geometry.parameters.height, object.geometry.parameters.depth],
    [1, 1, 1],
  );
  runtime.dispose();
});

test("valid finite Transform vectors are still applied", () => {
  const runtime = ThreeSceneRuntime.instantiate(
    project({ position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] }),
    sceneId,
  );
  const object = runtime.getObject(entityId)!;

  assert.deepEqual(object.position.toArray(), [1, 2, 3]);
  assert.deepEqual(object.scale.toArray(), [2, 2, 2]);
  runtime.dispose();
});
