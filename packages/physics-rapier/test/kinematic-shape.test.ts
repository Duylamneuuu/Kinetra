import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import { createPhysicsWorldFromScene } from "../src/index.js";

function scene(entities: SceneDefinition["entities"]): SceneDefinition {
  return { id: stableId("scene", "kinematic-shape"), name: "Kinematic shape", entities };
}

// Rapier ShapeType: 0 ball, 1 cuboid, 2 capsule.
function colliderShapes(physics: Awaited<ReturnType<typeof createPhysicsWorldFromScene>>) {
  const shapes: Array<{ cuboid?: [number, number, number]; ball?: number; capsule?: boolean }> = [];
  physics.world.forEachCollider((collider) => {
    const type = collider.shapeType() as number;
    if (type === 1) {
      const half = collider.halfExtents();
      assert.ok(half, "a cuboid has half extents");
      shapes.push({ cuboid: [half.x, half.y, half.z] });
    } else if (type === 0) {
      shapes.push({ ball: collider.radius() });
    } else {
      shapes.push({ capsule: true });
    }
  });
  return shapes;
}

for (const type of ["kinematic", "kinematicPositionBased", "kinematicVelocityBased"]) {
  test(`${type} body with a box Collider keeps the box shape (not a capsule)`, async () => {
    const physics = await createPhysicsWorldFromScene(
      scene([
        {
          id: "platform",
          name: "Platform",
          components: {
            Transform: { position: [0, 2, 0] },
            RigidBody: { type },
            Collider: { shape: "box", size: [4, 0.5, 6] },
          },
        },
      ]),
    );
    try {
      assert.deepEqual(colliderShapes(physics), [{ cuboid: [2, 0.25, 3] }]);
      assert.deepEqual(physics.characterIds(), [], "a platform is not a character controller");
      assert.equal(physics.hasBody("platform"), true);
    } finally {
      physics.dispose();
    }
  });
}

test("kinematic sphere Collider keeps its radius; capsule and undeclared shapes stay characters", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "orb",
        name: "Orb",
        components: {
          Transform: { position: [0, 2, 0] },
          RigidBody: { type: "kinematicPositionBased" },
          Collider: { shape: "sphere", radius: 1.5 },
        },
      },
      {
        id: "hero",
        name: "Hero",
        components: {
          Transform: { position: [10, 1, 0] },
          RigidBody: { type: "kinematicPositionBased" },
          Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
        },
      },
      {
        id: "bare",
        name: "Bare",
        components: { Transform: { position: [20, 1, 0] }, RigidBody: { type: "kinematic" } },
      },
    ]),
  );
  try {
    assert.deepEqual(physics.characterIds().sort(), ["bare", "hero"]);
    assert.ok(colliderShapes(physics).some((shape) => shape.ball === 1.5));
  } finally {
    physics.dispose();
  }
});

test("a box platform driven with moveKinematicBody carries the dynamic crate resting on it", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "platform",
        name: "Platform",
        components: {
          Transform: { position: [0, 0, 0] },
          RigidBody: { type: "kinematicVelocityBased" },
          Collider: { shape: "box", size: [10, 1, 10] },
        },
      },
      {
        id: "crate",
        name: "Crate",
        components: {
          Transform: { position: [0, 1, 0] },
          RigidBody: { type: "dynamic" },
          Collider: { shape: "box", size: [1, 1, 1] },
        },
      },
    ]),
  );
  try {
    for (let i = 1; i <= 60; i += 1) {
      physics.moveKinematicBody("platform", { x: 0, y: i * 0.05, z: 0 });
      physics.step();
    }
    const platform = physics.state("platform");
    const crate = physics.state("crate");
    assert.ok(Math.abs(platform.position.y - 3) < 1e-6, `platform y ${platform.position.y}`);
    assert.ok(crate.position.y > 3.3, `crate was carried up with the platform (y=${crate.position.y})`);
    assert.ok(Math.abs(crate.position.x) < 0.2 && Math.abs(crate.position.z) < 0.2);
  } finally {
    physics.dispose();
  }
});

test("moveKinematicBody rejects non-kinematic bodies and non-finite targets", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "crate",
        name: "Crate",
        components: {
          Transform: { position: [0, 1, 0] },
          RigidBody: { type: "dynamic" },
          Collider: { shape: "box", size: [1, 1, 1] },
        },
      },
      {
        id: "door",
        name: "Door",
        components: {
          Transform: { position: [5, 1, 0] },
          RigidBody: { type: "kinematicPositionBased" },
          Collider: { shape: "box", size: [1, 2, 0.2] },
        },
      },
    ]),
  );
  try {
    assert.throws(() => physics.moveKinematicBody("crate", { x: 0, y: 2, z: 0 }), /not kinematic/);
    assert.throws(() => physics.moveKinematicBody("door", { x: Number.NaN, y: 0, z: 0 }), RangeError);
    assert.throws(() => physics.moveKinematicBody("missing", { x: 0, y: 0, z: 0 }));
  } finally {
    physics.dispose();
  }
});

test("addKinematicBody validates its shape before creating anything", async () => {
  const physics = await createPhysicsWorldFromScene(scene([]));
  try {
    for (const input of [
      { id: "a", position: { x: 0, y: 0, z: 0 }, shape: "box" as const, halfExtents: { x: 0, y: 1, z: 1 } },
      { id: "b", position: { x: 0, y: 0, z: 0 }, shape: "sphere" as const, radius: -1 },
      { id: "c", position: { x: Number.NaN, y: 0, z: 0 }, shape: "box" as const },
    ]) {
      assert.throws(() => physics.addKinematicBody(input), RangeError, input.id);
    }
    assert.equal(physics.stats().bodies, 0);
  } finally {
    physics.dispose();
  }
});
