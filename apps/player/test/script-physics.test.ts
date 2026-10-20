import assert from "node:assert/strict";
import test from "node:test";

import { RapierPhysicsWorld } from "@kinetra/physics-rapier";

import {
  PHYSICS_WORLD_UNAVAILABLE,
  createScriptPhysicsService,
} from "../src/script-physics.js";

test("script physics queries hit the live world and refuse a missing one", async () => {
  const world = await RapierPhysicsWorld.create();
  try {
    world.addFixedBox({
      id: "floor",
      position: { x: 0, y: -0.5, z: 0 },
      halfExtents: { x: 4, y: 0.5, z: 4 },
    });
    let current: RapierPhysicsWorld | undefined = world;
    const physics = createScriptPhysicsService(() => current);

    const ray = physics.raycast({
      origin: { x: 1, y: 3, z: -1 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.equal(ray?.entityId, "floor");
    assert.ok(ray && Math.abs(ray.point.y) < 1e-3);

    const sweep = physics.shapeCast({
      shape: { type: "box", halfExtents: { x: 0.25, y: 0.5, z: 0.25 } },
      origin: { x: 1, y: 0.5, z: -1 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.equal(sweep?.entityId, "floor");
    assert.ok(sweep && Math.abs(sweep.distance) < 1e-3);
    assert.ok(sweep && Math.abs(sweep.point.y) < 1e-3);
    assert.ok(sweep && Math.abs(sweep.point.x - 1) < 1e-3);

    current = undefined;
    assert.throws(() => physics.raycast({
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    }), new RegExp(PHYSICS_WORLD_UNAVAILABLE));
    assert.throws(() => physics.shapeCast({
      shape: { type: "sphere", radius: 0.2 },
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    }), new RegExp(PHYSICS_WORLD_UNAVAILABLE));
  } finally {
    world.dispose();
  }
});
