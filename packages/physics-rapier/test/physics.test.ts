import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import {
  createPhysicsWorldFromScene,
  RapierPhysicsWorld,
} from "../src/index.js";

test("fixed-step simulation lands a dynamic ball on ground", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    physics.addFixedBox({
      id: "ground",
      position: { x: 0, y: -0.5, z: 0 },
      halfExtents: { x: 10, y: 0.5, z: 10 },
    });
    physics.addDynamicBody({
      id: "ball",
      position: { x: 0, y: 4, z: 0 },
      shape: "sphere",
      radius: 0.5,
      restitution: 0,
    });

    for (let i = 0; i < 240; i++) {
      physics.advance(1 / 60);
    }

    const ball = physics.state("ball");
    assert.ok(
      ball.position.y > 0.45 && ball.position.y < 0.65,
      `Expected ball.position.y to be ~0.5, got ${ball.position.y}`,
    );
    assert.ok(
      Math.abs(ball.linearVelocity.y) < 0.1,
      `Expected low velocity, got ${ball.linearVelocity.y}`,
    );
    assert.equal(physics.stats().fixedSteps, 240);

    // Verify all values are valid numbers (no NaN / Infinity)
    assert.ok(Number.isFinite(ball.position.x));
    assert.ok(Number.isFinite(ball.position.y));
    assert.ok(Number.isFinite(ball.position.z));
  } finally {
    physics.dispose();
  }
});

test("fixed-step accumulator is independent of render delta partition", async () => {
  const a = await RapierPhysicsWorld.create();
  const b = await RapierPhysicsWorld.create();
  try {
    a.addDynamicBody({
      id: "ball",
      position: { x: 0, y: 10, z: 0 },
      shape: "sphere",
      radius: 0.5,
    });
    b.addDynamicBody({
      id: "ball",
      position: { x: 0, y: 10, z: 0 },
      shape: "sphere",
      radius: 0.5,
    });

    for (let i = 0; i < 60; i++) a.advance(1 / 60);
    for (let i = 0; i < 30; i++) b.advance(1 / 30);

    assert.equal(a.stats().fixedSteps, 60);
    assert.equal(b.stats().fixedSteps, 60);
    assert.ok(
      Math.abs(a.state("ball").position.y - b.state("ball").position.y) < 1e-4,
      `Discrepancy: ${a.state("ball").position.y} vs ${b.state("ball").position.y}`,
    );
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("kinematic character movement is clipped by world colliders", async () => {
  const physics = await RapierPhysicsWorld.create({
    gravity: { x: 0, y: 0, z: 0 },
  });
  try {
    physics.addFixedBox({
      id: "wall",
      position: { x: 2, y: 1, z: 0 },
      halfExtents: { x: 0.25, y: 2, z: 2 },
    });
    physics.addKinematicCharacter({
      id: "player",
      position: { x: 0, y: 1, z: 0 },
      halfHeight: 0.5,
      radius: 0.4,
      offset: 0.01,
    });

    // Desired displacement is 4 units in +x direction
    const movement = physics.moveCharacter("player", { x: 4, y: 0, z: 0 });

    // Wall west face is at 2 - 0.25 = 1.75
    // Capsule radius is 0.4, so max allowed x is 1.75 - 0.4 = 1.35
    assert.equal(movement.requested.x, 4);
    assert.ok(
      movement.actual.x < 1.75,
      `Expected movement.actual.x < 1.75, got ${movement.actual.x}`,
    );
    assert.ok(
      movement.actual.x > 1.2,
      `Expected movement.actual.x > 1.2, got ${movement.actual.x}`,
    );
    assert.equal(movement.collided, true);

    physics.step(1 / 60);
    const playerState = physics.state("player");
    assert.ok(
      playerState.position.x < 1.75,
      `Player ended up past wall: ${playerState.position.x}`,
    );
    assert.ok(
      playerState.position.x > 1.2,
      `Player did not move close to wall: ${playerState.position.x}`,
    );
  } finally {
    physics.dispose();
  }
});

test("createPhysicsWorldFromScene instantiates bodies from SceneDefinition", async () => {
  const scene: SceneDefinition = {
    id: stableId("scene", "physics-test"),
    name: "Physics Test",
    entities: [
      {
        id: "floor",
        name: "Floor",
        components: {
          Transform: { position: [0, -0.5, 0] },
          Primitive: { kind: "box", size: [10, 1, 10] },
          RigidBody: { type: "fixed" },
          Collider: { shape: "box", size: [10, 1, 10] },
        },
      },
      {
        id: "wall",
        name: "Wall",
        components: {
          Transform: { position: [2, 1, 0] },
          Primitive: { kind: "box", size: [0.5, 2, 2] },
          RigidBody: { type: "fixed" },
          Collider: { shape: "box", size: [0.5, 2, 2] },
        },
      },
      {
        id: "ball",
        name: "Ball",
        components: {
          Transform: { position: [0, 4, 0] },
          Primitive: { kind: "sphere", radius: 0.5 },
          RigidBody: { type: "dynamic" },
          Collider: { shape: "sphere", radius: 0.5 },
        },
      },
      {
        id: "player",
        name: "Player",
        components: {
          Transform: { position: [0, 1, 0] },
          CharacterBody: { speed: 5 },
          Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
        },
      },
    ],
  };

  const physics = await createPhysicsWorldFromScene(scene);
  try {
    assert.equal(physics.hasBody("floor"), true);
    assert.equal(physics.hasBody("wall"), true);
    assert.equal(physics.hasBody("ball"), true);
    assert.equal(physics.hasBody("player"), true);

    const initialBall = physics.state("ball");
    assert.equal(initialBall.position.y, 4);

    // Stepping physics makes the ball fall
    for (let i = 0; i < 60; i++) {
      physics.step(1 / 60);
    }

    const fallenBall = physics.state("ball");
    assert.ok(
      fallenBall.position.y < 4,
      `Expected ball to fall, but was at ${fallenBall.position.y}`,
    );

    // Player movement clips against wall
    const moveResult = physics.moveCharacter("player", { x: 4, y: 0, z: 0 });
    assert.ok(moveResult.actual.x < 1.75);
    assert.equal(moveResult.collided, true);
  } finally {
    physics.dispose();
  }
});

test("physics world disposal is clean and idempotent", async () => {
  const physics = await RapierPhysicsWorld.create();
  physics.addFixedBox({
    id: "box",
    position: { x: 0, y: 0, z: 0 },
    halfExtents: { x: 1, y: 1, z: 1 },
  });
  physics.addKinematicCharacter({
    id: "char",
    position: { x: 0, y: 2, z: 0 },
    halfHeight: 0.5,
    radius: 0.4,
  });

  physics.dispose();
  // Multiple disposes are safe and idempotent
  physics.dispose();
});


// --- Regression tests (luồng C): timestep leakage and non-finite input guards ---

test("step(dt) does not leak its timestep into later fixed-step advance()", async () => {
  const physics = await RapierPhysicsWorld.create({ fixedDeltaSeconds: 1 / 60 });
  try {
    physics.addDynamicBody({ id: "ball", position: { x: 0, y: 100, z: 0 }, shape: "sphere", radius: 0.5 });
    physics.step(0.5);
    const afterStep = physics.state("ball").linearVelocity.y;
    assert.ok(Math.abs(afterStep - -9.81 * 0.5) < 1e-3, `step(0.5) should integrate 0.5s, got v=${afterStep}`);

    assert.equal(physics.advance(1 / 60), 1);
    const delta = physics.state("ball").linearVelocity.y - afterStep;
    assert.ok(
      Math.abs(delta - -9.81 / 60) < 1e-3,
      `one fixed step must integrate 1/60s, got dv=${delta} (expected ${-9.81 / 60})`,
    );
    // Rapier stores the timestep as f32, so compare with a tolerance.
    assert.ok(Math.abs(physics.world.timestep - 1 / 60) < 1e-6, `timestep restored, got ${physics.world.timestep}`);
  } finally {
    physics.dispose();
  }
});

test("step rejects non-finite or non-positive explicit timesteps", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    for (const dt of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1 / 60]) {
      assert.throws(() => physics.step(dt), RangeError, `step(${dt})`);
    }
    assert.equal(physics.stats().fixedSteps, 0);
  } finally {
    physics.dispose();
  }
});

test("create rejects a non-finite fixedDeltaSeconds", async () => {
  await assert.rejects(() => RapierPhysicsWorld.create({ fixedDeltaSeconds: Number.POSITIVE_INFINITY }), RangeError);
  await assert.rejects(() => RapierPhysicsWorld.create({ fixedDeltaSeconds: Number.NaN }), RangeError);
});

test("moveCharacter and setBodyTranslation reject non-finite vectors without corrupting the body", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    physics.addKinematicCharacter({ id: "player", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.3 });
    assert.throws(() => physics.moveCharacter("player", { x: Number.NaN, y: 0, z: 0 }), RangeError);
    assert.throws(() => physics.setBodyTranslation("player", { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }), RangeError);
    const state = physics.state("player");
    assert.deepEqual(state.position, { x: 0, y: 1, z: 0 });
  } finally {
    physics.dispose();
  }
});
