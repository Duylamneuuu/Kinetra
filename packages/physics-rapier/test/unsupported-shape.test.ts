import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import {
  collectPhysicsSceneDiagnostics,
  createPhysicsWorldFromScene,
  type PhysicsSceneDiagnostic,
} from "../src/index.js";

function scene(entities: SceneDefinition["entities"]): SceneDefinition {
  return { id: stableId("scene", "unsupported-shape"), name: "Unsupported shapes", entities };
}

const at = { Transform: { position: [0, 0, 0] } };

test("a fixed Collider with an unsupported shape reports a structured diagnostic instead of silently becoming a box (#354)", async () => {
  const diagnostics: PhysicsSceneDiagnostic[] = [];
  const physics = await createPhysicsWorldFromScene(
    scene([{ id: "drum", name: "Drum", components: { ...at, Collider: { shape: "cylinder", radius: 2 } } }]),
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );
  try {
    assert.equal(diagnostics.length, 1);
    const [diagnostic] = diagnostics;
    assert.equal(diagnostic?.code, "physics.unsupportedColliderShape");
    assert.equal(diagnostic?.entityId, "drum");
    assert.equal(diagnostic?.shape, "cylinder");
    assert.equal(diagnostic?.source, "Collider.shape");
    assert.equal(diagnostic?.bodyType, "fixed");
    assert.equal(diagnostic?.fallback, "box");
    assert.match(diagnostic?.message ?? "", /cylinder/);
    assert.match(diagnostic?.remediation ?? "", /box.*sphere.*capsule/);
    // Behaviour is unchanged (still the default box) so existing scenes keep loading.
    assert.equal(physics.stats().bodies, 1);
  } finally {
    physics.dispose();
  }
});

test("dynamic and kinematic bodies with unsupported shapes report their own fallback", async () => {
  const diagnostics: PhysicsSceneDiagnostic[] = [];
  const physics = await createPhysicsWorldFromScene(
    scene([
      { id: "cone", name: "Cone", components: { ...at, RigidBody: { type: "dynamic" }, Collider: { shape: "cone" } } },
      {
        id: "lift",
        name: "Lift",
        components: { Transform: { position: [10, 0, 0] }, RigidBody: { type: "kinematic" }, Collider: { shape: "Box" } },
      },
    ]),
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );
  try {
    assert.deepEqual(
      diagnostics.map((d) => [d.entityId, d.shape, d.bodyType, d.fallback]),
      [
        ["cone", "cone", "dynamic", "box"],
        ["lift", "Box", "kinematic", "capsule"],
      ],
    );
  } finally {
    physics.dispose();
  }
});

test("supported shapes, Primitive kinds and undeclared shapes report nothing", async () => {
  const entities: SceneDefinition["entities"] = [
    { id: "a", name: "A", components: { ...at, Collider: { shape: "box" } } },
    { id: "b", name: "B", components: { Transform: { position: [5, 0, 0] }, Collider: { shape: "sphere" } } },
    { id: "c", name: "C", components: { Transform: { position: [10, 0, 0] }, Collider: { shape: "ball" } } },
    { id: "d", name: "D", components: { Transform: { position: [15, 0, 0] }, Collider: { shape: "capsule" } } },
    { id: "e", name: "E", components: { Transform: { position: [20, 0, 0] }, Collider: {} } },
    {
      id: "f",
      name: "Floor",
      components: { Transform: { position: [0, -5, 0] }, RigidBody: { type: "fixed" }, Primitive: { kind: "plane", size: [20, 0.2, 20] } },
    },
    { id: "g", name: "G", components: { Transform: { position: [0, 10, 0] }, RigidBody: { type: "dynamic" }, Collider: { shape: "capsule" } } },
    { id: "h", name: "H", components: { Transform: { position: [0, 20, 0] }, CharacterBody: {}, Collider: { shape: "capsule" } } },
  ];
  assert.deepEqual(collectPhysicsSceneDiagnostics(scene(entities)), []);
  const diagnostics: PhysicsSceneDiagnostic[] = [];
  const physics = await createPhysicsWorldFromScene(scene(entities), {
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  physics.dispose();
  assert.deepEqual(diagnostics, []);
});

test("collectPhysicsSceneDiagnostics reports a non-string or Primitive-sourced unsupported shape without building a world", () => {
  const diagnostics = collectPhysicsSceneDiagnostics(
    scene([
      { id: "n", name: "N", components: { ...at, Collider: { shape: 7 } } },
      { id: "p", name: "P", components: { ...at, RigidBody: { type: "fixed" }, Primitive: { kind: "torus" } } },
    ]),
  );
  assert.deepEqual(
    diagnostics.map((d) => [d.entityId, d.shape, d.source]),
    [
      ["n", "7", "Collider.shape"],
      ["p", "torus", "Primitive.kind"],
    ],
  );
});

test("a throwing onDiagnostic handler does not leak the world or abort the scene", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([{ id: "drum", name: "Drum", components: { ...at, Collider: { shape: "cylinder" } } }]),
    {
      onDiagnostic: () => {
        throw new Error("logger broke");
      },
    },
  );
  try {
    assert.equal(physics.stats().bodies, 1);
  } finally {
    physics.dispose();
  }
});
