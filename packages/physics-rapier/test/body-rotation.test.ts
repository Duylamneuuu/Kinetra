import assert from "node:assert/strict";
import test from "node:test";

import { RapierPhysicsWorld } from "../src/index.js";

// Refs #466: the add* body methods take an optional initial orientation.

const QUARTER_Y = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) };

async function world(): Promise<RapierPhysicsWorld> {
  return RapierPhysicsWorld.create();
}

test("every body kind accepts an initial rotation and reports it back", async () => {
  const physics = await world();
  try {
    physics.addFixedBox({ id: "box", position: { x: 0, y: 0, z: 0 }, rotation: QUARTER_Y, halfExtents: { x: 1, y: 1, z: 1 } });
    physics.addFixedSphere({ id: "sphere", position: { x: 5, y: 0, z: 0 }, rotation: QUARTER_Y, radius: 1 });
    physics.addFixedCapsule({ id: "capsule", position: { x: 10, y: 0, z: 0 }, rotation: QUARTER_Y, halfHeight: 1, radius: 0.5 });
    physics.addDynamicBody({ id: "dyn", position: { x: 15, y: 0, z: 0 }, rotation: QUARTER_Y, shape: "box", halfExtents: { x: 1, y: 1, z: 1 }, gravityScale: 0 });
    physics.addKinematicBody({ id: "kin", position: { x: 20, y: 0, z: 0 }, rotation: QUARTER_Y, shape: "box", halfExtents: { x: 1, y: 1, z: 1 } });
    for (const id of ["box", "sphere", "capsule", "dyn", "kin"]) {
      const q = physics.state(id).rotation;
      assert.ok(Math.abs(q.y - QUARTER_Y.y) < 1e-6 && Math.abs(q.w - QUARTER_Y.w) < 1e-6, `${id} rotation ${JSON.stringify(q)}`);
    }
  } finally {
    physics.dispose();
  }
});

test("omitting rotation keeps the identity orientation", async () => {
  const physics = await world();
  try {
    physics.addFixedBox({ id: "box", position: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } });
    assert.deepEqual(physics.state("box").rotation, { x: 0, y: 0, z: 0, w: 1 });
  } finally {
    physics.dispose();
  }
});

test("a rotation that is not a finite unit quaternion is rejected before any body is created", async () => {
  const physics = await world();
  try {
    const bad = [
      { x: 0, y: 0, z: 0, w: 0 },
      { x: 0, y: 0, z: 0, w: 2 },
      { x: Number.NaN, y: 0, z: 0, w: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, z: 0, w: 1 },
    ];
    for (const rotation of bad) {
      assert.throws(
        () => physics.addFixedBox({ id: "b", position: { x: 0, y: 0, z: 0 }, rotation, halfExtents: { x: 1, y: 1, z: 1 } }),
        RangeError,
      );
      assert.throws(
        () => physics.addDynamicBody({ id: "b", position: { x: 0, y: 0, z: 0 }, rotation, shape: "sphere", radius: 1 }),
        RangeError,
      );
      assert.throws(
        () => physics.addKinematicBody({ id: "b", position: { x: 0, y: 0, z: 0 }, rotation, shape: "sphere", radius: 1 }),
        RangeError,
      );
    }
    assert.equal(physics.stats().bodies, 0, "no orphan body after a rejected rotation");
    // The id stays free.
    physics.addFixedBox({ id: "b", position: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } });
  } finally {
    physics.dispose();
  }
});

test("moveKinematicBody moves a rotated platform without resetting its rotation", async () => {
  const physics = await world();
  try {
    physics.addKinematicBody({ id: "kin", position: { x: 0, y: 0, z: 0 }, rotation: QUARTER_Y, shape: "box", halfExtents: { x: 1, y: 1, z: 1 } });
    physics.moveKinematicBody("kin", { x: 3, y: 0, z: 0 });
    physics.step();
    const state = physics.state("kin");
    assert.ok(Math.abs(state.position.x - 3) < 1e-6);
    assert.ok(Math.abs(state.rotation.y - QUARTER_Y.y) < 1e-6);
  } finally {
    physics.dispose();
  }
});
