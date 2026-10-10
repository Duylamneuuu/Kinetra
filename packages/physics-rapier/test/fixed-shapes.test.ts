import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import { RapierPhysicsWorld, createPhysicsWorldFromScene } from "../src/index.js";

function scene(entities: SceneDefinition["entities"]): SceneDefinition {
  return { id: stableId("scene", "fixed-shapes"), name: "Fixed shapes", entities };
}

// Ray from +x toward -x along y=0: the hit x is the surface of the body at the origin.
function surfaceX(physics: RapierPhysicsWorld): number {
  const hit = physics.raycast({ origin: { x: 20, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 } });
  assert.ok(hit, "ray must hit the body");
  return hit.point.x;
}

test("a fixed sphere Collider keeps its radius instead of becoming a unit box", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([{ id: "ball", name: "Ball", components: { Transform: { position: [0, 0, 0] }, Collider: { shape: "sphere", radius: 3 } } }]),
  );
  try {
    assert.ok(Math.abs(surfaceX(physics) - 3) < 1e-6, "a radius 3 sphere is hit at x=3, not at the unit box face x=0.5");
    // Off-axis: a sphere is not hit at (0,2.5) by a +/-0.5 box, a radius-3 sphere is.
    const high = physics.raycast({ origin: { x: 20, y: 2.5, z: 0 }, direction: { x: -1, y: 0, z: 0 } });
    assert.ok(high, "the sphere reaches y=2.5");
  } finally {
    physics.dispose();
  }
});

test("a fixed body whose Primitive is a sphere uses the primitive radius", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "orb",
        name: "Orb",
        components: { Transform: { position: [0, 0, 0] }, RigidBody: { type: "fixed" }, Primitive: { kind: "sphere", radius: 2 } },
      },
    ]),
  );
  try {
    assert.ok(Math.abs(surfaceX(physics) - 2) < 1e-6);
  } finally {
    physics.dispose();
  }
});

test("a fixed capsule Collider keeps its half height and radius", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "pillar",
        name: "Pillar",
        components: { Transform: { position: [0, 0, 0] }, Collider: { shape: "capsule", radius: 1, halfHeight: 4 } },
      },
    ]),
  );
  try {
    assert.ok(Math.abs(surfaceX(physics) - 1) < 1e-4, "capsule radius 1");
    const top = physics.raycast({ origin: { x: 0, y: 20, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    assert.ok(top && Math.abs(top.point.y - 5) < 1e-4, "capsule top is halfHeight + radius = 5");
  } finally {
    physics.dispose();
  }
});

test("a fixed box Collider and the default shape are unchanged", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([{ id: "wall", name: "Wall", components: { Transform: { position: [0, 0, 0] }, Collider: { size: [4, 2, 2] } } }]),
  );
  try {
    assert.ok(Math.abs(surfaceX(physics) - 2) < 1e-6);
  } finally {
    physics.dispose();
  }
});

test("addFixedSphere / addFixedCapsule validate their input and leave no orphan body", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    assert.throws(() => physics.addFixedSphere({ id: "bad", position: { x: 0, y: 0, z: 0 }, radius: 0 }), RangeError);
    assert.throws(() => physics.addFixedSphere({ id: "bad", position: { x: Number.NaN, y: 0, z: 0 }, radius: 1 }), RangeError);
    assert.throws(() => physics.addFixedCapsule({ id: "bad", position: { x: 0, y: 0, z: 0 }, radius: 1, halfHeight: -1 }), RangeError);
    assert.equal(physics.stats().bodies, 0);
    physics.addFixedSphere({ id: "ok", position: { x: 0, y: 0, z: 0 }, radius: 1 });
    assert.throws(() => physics.addFixedSphere({ id: "ok", position: { x: 0, y: 0, z: 0 }, radius: 1 }), /already exists/);
    assert.equal(physics.stats().bodies, 1);
  } finally {
    physics.dispose();
  }
});
