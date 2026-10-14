import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import {
  collectPhysicsSceneDiagnostics,
  createPhysicsWorldFromScene,
  resolveColliderPlan,
  type ColliderPlan,
} from "../src/index.js";

// #383 item 2: `diagnoseEntity` used to re-derive the body kind / shape that `populateWorld`
// decides, so the two could drift. Both now go through `resolveColliderPlan`; this table pins the
// plan, the diagnostic derived from it and the shape the world really builds, for every branch.

type Components = SceneDefinition["entities"][number]["components"];

interface Row {
  readonly name: string;
  readonly components: Components;
  readonly plan: ColliderPlan;
}

// Sized so each shape is told apart by a ray along -x from x = 10 through the origin:
// box halfExtents 2 -> distance 8; sphere radius 1 / capsule radius 1 -> distance 9.
const size = { halfExtents: [2, 2, 2], radius: 1, halfHeight: 1 };
const at = { Transform: { position: [0, 0, 0] } };
const BOX = 8;
const ROUND = 9;

const rows: readonly Row[] = [
  { name: "fixed box", components: { ...at, Collider: { ...size, shape: "box" } }, plan: { bodyType: "fixed", shape: "box" } },
  { name: "fixed sphere", components: { ...at, Collider: { ...size, shape: "sphere" } }, plan: { bodyType: "fixed", shape: "sphere" } },
  { name: "fixed ball", components: { ...at, Collider: { ...size, shape: "ball" } }, plan: { bodyType: "fixed", shape: "sphere" } },
  { name: "fixed capsule", components: { ...at, Collider: { ...size, shape: "capsule" } }, plan: { bodyType: "fixed", shape: "capsule" } },
  {
    name: "fixed cylinder",
    components: { ...at, Collider: { ...size, shape: "cylinder" } },
    plan: { bodyType: "fixed", shape: "box", unsupported: { shape: "cylinder", source: "Collider.shape" } },
  },
  {
    name: "fixed numeric shape",
    components: { ...at, Collider: { ...size, shape: 7 } },
    plan: { bodyType: "fixed", shape: "box", unsupported: { shape: "7", source: "Collider.shape" } },
  },
  {
    name: "fixed Primitive torus",
    components: { ...at, RigidBody: { type: "fixed" }, Primitive: { kind: "torus", size: [4, 4, 4] } },
    plan: { bodyType: "fixed", shape: "box", unsupported: { shape: "torus", source: "Primitive.kind" } },
  },
  {
    name: "fixed Primitive plane",
    components: { ...at, RigidBody: { type: "fixed" }, Primitive: { kind: "plane", size: [4, 4, 4] } },
    plan: { bodyType: "fixed", shape: "box" },
  },
  {
    name: "fixed Primitive sphere",
    components: { ...at, RigidBody: { type: "fixed" }, Primitive: { kind: "sphere", radius: 1 } },
    plan: { bodyType: "fixed", shape: "sphere" },
  },
  {
    // An empty Collider.shape is "declared but blank": it does not fall through to the Primitive.
    name: "fixed blank shape hides Primitive kind",
    components: { ...at, Collider: { ...size, shape: "" }, Primitive: { kind: "torus" } },
    plan: { bodyType: "fixed", shape: "box" },
  },
  {
    name: "dynamic cone",
    components: { ...at, RigidBody: { type: "dynamic", gravityScale: 0 }, Collider: { ...size, shape: "cone" } },
    plan: { bodyType: "dynamic", shape: "box", unsupported: { shape: "cone", source: "Collider.shape" } },
  },
  {
    name: "dynamic ball",
    components: { ...at, RigidBody: { type: "dynamic", gravityScale: 0 }, Collider: { ...size, shape: "ball" } },
    plan: { bodyType: "dynamic", shape: "sphere" },
  },
  {
    name: "dynamic capsule",
    components: { ...at, RigidBody: { type: "dynamic", gravityScale: 0 }, Collider: { ...size, shape: "capsule" } },
    plan: { bodyType: "dynamic", shape: "capsule" },
  },
  {
    name: "kinematic box keeps its shape",
    components: { ...at, RigidBody: { type: "kinematic" }, Collider: { ...size, shape: "box" } },
    plan: { bodyType: "kinematic", shape: "box" },
  },
  {
    name: "kinematic ball keeps its shape",
    components: { ...at, RigidBody: { type: "kinematic" }, Collider: { ...size, shape: "ball" } },
    plan: { bodyType: "kinematic", shape: "sphere" },
  },
  {
    name: "kinematic velocity-based sphere",
    components: { ...at, RigidBody: { type: "kinematicVelocityBased" }, Collider: { ...size, shape: "sphere" } },
    plan: { bodyType: "kinematic", shape: "sphere" },
  },
  {
    name: "kinematic capsule",
    components: { ...at, RigidBody: { type: "kinematic" }, Collider: { ...size, shape: "capsule" } },
    plan: { bodyType: "kinematic", shape: "capsule" },
  },
  {
    name: "kinematic undeclared shape",
    components: { ...at, RigidBody: { type: "kinematic" }, Collider: { radius: 1, halfHeight: 1 } },
    plan: { bodyType: "kinematic", shape: "capsule" },
  },
  {
    name: "kinematic cylinder",
    components: { ...at, RigidBody: { type: "kinematic" }, Collider: { ...size, shape: "cylinder" } },
    plan: { bodyType: "kinematic", shape: "capsule", unsupported: { shape: "cylinder", source: "Collider.shape" } },
  },
  {
    name: "kinematic capitalised Box",
    components: { ...at, RigidBody: { type: "kinematic" }, Collider: { ...size, shape: "Box" } },
    plan: { bodyType: "kinematic", shape: "capsule", unsupported: { shape: "Box", source: "Collider.shape" } },
  },
  {
    name: "character with a box collider",
    components: { ...at, CharacterBody: {}, Collider: { ...size, shape: "box" } },
    plan: { bodyType: "character", shape: "capsule", unsupported: { shape: "box", source: "Collider.shape" } },
  },
  {
    name: "character with a capsule collider",
    components: { ...at, CharacterBody: {}, Collider: { ...size, shape: "capsule" } },
    plan: { bodyType: "character", shape: "capsule" },
  },
  {
    // A Primitive kind on a character is only its render mesh, never a mismatch.
    name: "character with a box Primitive",
    components: { ...at, CharacterBody: {}, Collider: { radius: 1, halfHeight: 1 }, Primitive: { kind: "box" } },
    plan: { bodyType: "character", shape: "capsule" },
  },
];

function scene(components: Components): SceneDefinition {
  return {
    id: stableId("scene", "collider-plan"),
    name: "Collider plan",
    entities: [{ id: "subject", name: "Subject", components }],
  };
}

function entityOf(components: Components): SceneDefinition["entities"][number] {
  return { id: "subject", name: "Subject", components };
}

test("resolveColliderPlan returns undefined for an entity with no physics components", () => {
  assert.equal(resolveColliderPlan(entityOf({ Transform: { position: [0, 0, 0] } })), undefined);
  assert.equal(resolveColliderPlan(entityOf({ Primitive: { kind: "box" } })), undefined);
});

for (const row of rows) {
  test(`plan: ${row.name}`, () => {
    assert.deepEqual(resolveColliderPlan(entityOf(row.components)), row.plan);
  });
}

test("collectPhysicsSceneDiagnostics is exactly the unsupported part of the plan, row by row", () => {
  for (const row of rows) {
    const diagnostics = collectPhysicsSceneDiagnostics(scene(row.components));
    if (!row.plan.unsupported) {
      assert.deepEqual(diagnostics, [], row.name);
      continue;
    }
    assert.equal(diagnostics.length, 1, row.name);
    const [diagnostic] = diagnostics;
    assert.equal(diagnostic?.shape, row.plan.unsupported.shape, row.name);
    assert.equal(diagnostic?.source, row.plan.unsupported.source, row.name);
    assert.equal(diagnostic?.bodyType, row.plan.bodyType, row.name);
    assert.equal(diagnostic?.fallback, row.plan.shape, row.name);
    assert.equal(diagnostic?.entityId, "subject", row.name);
  }
});

test("the world builds the shape the plan says, and the diagnostic's fallback is the shape built", async () => {
  for (const row of rows) {
    const physics = await createPhysicsWorldFromScene(scene(row.components));
    try {
      assert.equal(physics.stats().bodies, 1, row.name);
      const hit = physics.raycast({ origin: { x: 10, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 } });
      assert.ok(hit, `${row.name}: ray should hit the body`);
      assert.equal(hit.entityId, "subject", row.name);
      const expected = row.plan.shape === "box" ? BOX : ROUND;
      assert.ok(Math.abs(hit.distance - expected) < 1e-3, `${row.name}: ray distance ${hit.distance}, expected ${expected}`);
    } finally {
      physics.dispose();
    }
  }
});

test("a kinematic body is a character body only when the plan says capsule", async () => {
  for (const row of rows) {
    if (row.plan.bodyType !== "kinematic" && row.plan.bodyType !== "character") continue;
    const physics = await createPhysicsWorldFromScene(scene(row.components));
    try {
      assert.equal(physics.characterIds().includes("subject"), row.plan.shape === "capsule", row.name);
    } finally {
      physics.dispose();
    }
  }
});
