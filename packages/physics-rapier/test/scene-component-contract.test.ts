import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import { createPhysicsWorldFromScene } from "../src/index.js";

function scene(entities: SceneDefinition["entities"]): SceneDefinition {
  return { id: stableId("scene", "component-contract"), name: "Component contract", entities };
}

test("RigidBody.mass of a dynamic entity reaches the Rapier body (every shape)", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "crate",
        name: "Crate",
        components: {
          Transform: { position: [0, 5, 0] },
          RigidBody: { type: "dynamic", mass: 25 },
          Collider: { shape: "box", size: [1, 1, 1] },
        },
      },
      {
        id: "ball",
        name: "Ball",
        components: {
          Transform: { position: [5, 5, 0] },
          RigidBody: { type: "dynamic", mass: 7 },
          Collider: { shape: "sphere", radius: 0.5 },
        },
      },
      {
        id: "capsule",
        name: "Capsule",
        components: {
          Transform: { position: [-5, 5, 0] },
          RigidBody: { type: "dynamic", mass: 3 },
          Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
        },
      },
    ]),
  );
  try {
    const masses: number[] = [];
    physics.world.forEachRigidBody((body) => {
      masses.push(Math.round(body.mass() * 1000) / 1000);
    });
    assert.deepEqual(masses.sort((a, b) => a - b), [3, 7, 25]);
  } finally {
    physics.dispose();
  }
});

test("an invalid RigidBody.mass is rejected with a RangeError", async () => {
  await assert.rejects(
    createPhysicsWorldFromScene(
      scene([
        {
          id: "bad",
          name: "Bad",
          components: {
            Transform: { position: [0, 1, 0] },
            RigidBody: { type: "dynamic", mass: -4 },
            Collider: { shape: "sphere", radius: 0.5 },
          },
        },
      ]),
    ),
    RangeError,
  );
});

test("RigidBody type kinematicVelocityBased becomes a kinematic character, not a fixed box", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "elevator",
        name: "Elevator",
        components: {
          Transform: { position: [0, 1, 0] },
          RigidBody: { type: "kinematicVelocityBased" },
          Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
        },
      },
      {
        id: "platform",
        name: "Platform",
        components: {
          Transform: { position: [5, 1, 0] },
          RigidBody: { type: "kinematicPositionBased" },
          Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
        },
      },
    ]),
  );
  try {
    assert.deepEqual(physics.characterIds().sort(), ["elevator", "platform"]);
    const moved = physics.moveCharacter("elevator", { x: 0, y: 2, z: 0 });
    assert.equal(moved.actual.y, 2);
  } finally {
    physics.dispose();
  }
});
