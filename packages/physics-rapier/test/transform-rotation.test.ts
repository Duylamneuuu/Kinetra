import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import { createPhysicsWorldFromScene } from "../src/index.js";

// Refs #466: Transform.rotation used to be ignored when the scene factory built bodies, so a
// rotated wall collided as if it were axis-aligned while the player copied the body's identity
// quaternion back onto its mesh.

function scene(entities: SceneDefinition["entities"]): SceneDefinition {
  return { id: stableId("scene", "transform-rotation"), name: "Transform rotation", entities };
}

const HALF_PI = Math.PI / 2;
const SIN_QUARTER_PI = Math.sin(Math.PI / 4);

function near(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

test("a fixed box rotated 90 degrees about Y collides along its rotated long side", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "wall",
        name: "Wall",
        components: {
          Transform: { position: [0, 0, 0], rotation: [0, HALF_PI, 0] },
          RigidBody: { type: "fixed" },
          // Long (x) side is 2 each way; rotated about Y it points along z.
          Collider: { shape: "box", halfExtents: [2, 0.5, 0.5] },
        },
      },
    ]),
  );
  try {
    const hit = physics.raycast({ origin: { x: 0, y: 0, z: -20 }, direction: { x: 0, y: 0, z: 1 } });
    assert.ok(hit, "the ray along z must hit the wall");
    near(hit.point.z, -2, 1e-4, "rotated wall is hit at its long side (z = -2), not at the unrotated face z = -0.5");
    const state = physics.state("wall");
    near(state.rotation.y, SIN_QUARTER_PI, 1e-6, "body rotation.y");
    near(state.rotation.w, SIN_QUARTER_PI, 1e-6, "body rotation.w");
  } finally {
    physics.dispose();
  }
});

test("Transform.rotation uses the Euler XYZ order the render object applies", async () => {
  const rotation: [number, number, number] = [0.3, 0.5, -0.7];
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "slab",
        name: "Slab",
        components: {
          Transform: { position: [1, 2, 3], rotation },
          RigidBody: { type: "fixed" },
          Collider: { shape: "box", halfExtents: [1, 1, 1] },
        },
      },
    ]),
  );
  try {
    // three.js Quaternion.setFromEuler for order "XYZ".
    const [x, y, z] = rotation;
    const c1 = Math.cos(x / 2);
    const c2 = Math.cos(y / 2);
    const c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2);
    const s2 = Math.sin(y / 2);
    const s3 = Math.sin(z / 2);
    const q = physics.state("slab").rotation;
    near(q.x, s1 * c2 * c3 + c1 * s2 * s3, 1e-6, "x");
    near(q.y, c1 * s2 * c3 - s1 * c2 * s3, 1e-6, "y");
    near(q.z, c1 * c2 * s3 + s1 * s2 * c3, 1e-6, "z");
    near(q.w, c1 * c2 * c3 - s1 * s2 * s3, 1e-6, "w");
  } finally {
    physics.dispose();
  }
});

test("a fixed capsule rotated onto its side lies along x", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "log",
        name: "Log",
        components: {
          Transform: { position: [0, 0, 0], rotation: [0, 0, HALF_PI] },
          Collider: { shape: "capsule", radius: 1, halfHeight: 4 },
        },
      },
    ]),
  );
  try {
    const hit = physics.raycast({ origin: { x: 20, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 } });
    assert.ok(hit);
    near(hit.point.x, 5, 1e-3, "capsule tip is halfHeight + radius = 5 along x once rotated");
  } finally {
    physics.dispose();
  }
});

test("a dynamic body starts with its authored rotation", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "crate",
        name: "Crate",
        components: {
          Transform: { position: [0, 10, 0], rotation: [0, 0, HALF_PI] },
          RigidBody: { type: "dynamic", gravityScale: 0 },
          Collider: { shape: "box", halfExtents: [2, 0.5, 0.5] },
        },
      },
    ]),
  );
  try {
    const q = physics.state("crate").rotation;
    near(q.z, SIN_QUARTER_PI, 1e-6, "rotation.z");
    near(q.w, SIN_QUARTER_PI, 1e-6, "rotation.w");
    const hit = physics.raycast({ origin: { x: 0, y: 30, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    assert.ok(hit);
    near(hit.point.y, 12, 1e-3, "the rotated long side is vertical: top face at y = 10 + 2");
  } finally {
    physics.dispose();
  }
});

test("a kinematic box (moving platform) keeps its authored rotation", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "door",
        name: "Door",
        components: {
          Transform: { position: [0, 0, 0], rotation: [0, HALF_PI, 0] },
          RigidBody: { type: "kinematic" },
          Collider: { shape: "box", halfExtents: [2, 0.5, 0.5] },
        },
      },
    ]),
  );
  try {
    const hit = physics.raycast({ origin: { x: 0, y: 0, z: -20 }, direction: { x: 0, y: 0, z: 1 } });
    assert.ok(hit);
    near(hit.point.z, -2, 1e-4, "rotated kinematic door");
  } finally {
    physics.dispose();
  }
});

test("a missing, zero or malformed Transform.rotation leaves the body unrotated", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      { id: "none", name: "None", components: { Transform: { position: [0, 0, 0] }, Collider: { shape: "box", size: [1, 1, 1] } } },
      { id: "zero", name: "Zero", components: { Transform: { position: [10, 0, 0], rotation: [0, 0, 0] }, Collider: { shape: "box", size: [1, 1, 1] } } },
      { id: "short", name: "Short", components: { Transform: { position: [20, 0, 0], rotation: [1, 2] }, Collider: { shape: "box", size: [1, 1, 1] } } },
      { id: "nan", name: "NaN", components: { Transform: { position: [30, 0, 0], rotation: [Number.NaN, 0, 0] }, Collider: { shape: "box", size: [1, 1, 1] } } },
    ]),
  );
  try {
    for (const id of ["none", "zero", "short", "nan"]) {
      assert.deepEqual(physics.state(id).rotation, { x: 0, y: 0, z: 0, w: 1 }, id);
    }
  } finally {
    physics.dispose();
  }
});

test("a character capsule stays unrotated: its facing belongs to the render object", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "hero",
        name: "Hero",
        components: {
          Transform: { position: [0, 1, 0], rotation: [0, 1, 0] },
          CharacterBody: {},
          Collider: { shape: "capsule", radius: 0.4, halfHeight: 0.5 },
        },
      },
    ]),
  );
  try {
    assert.deepEqual(physics.state("hero").rotation, { x: 0, y: 0, z: 0, w: 1 });
  } finally {
    physics.dispose();
  }
});
