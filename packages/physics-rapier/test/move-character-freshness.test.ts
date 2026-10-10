import assert from "node:assert/strict";
import test from "node:test";

import { RapierPhysicsWorld } from "../src/index.js";

// Luồng C: moveCharacter must not advance the simulation, and must see colliders that were added
// or teleported since the last step (the broad phase is only rebuilt inside Rapier's step()).

test("the first moveCharacter does not secretly run a real simulation step", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    physics.addDynamicBody({ id: "ball", position: { x: 0, y: 10, z: 0 }, shape: "sphere", radius: 0.5 });
    physics.addKinematicCharacter({ id: "player", position: { x: 5, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });

    physics.moveCharacter("player", { x: 1, y: 0, z: 0 });

    assert.equal(physics.stats().fixedSteps, 0, "a character move must not count as a fixed step");
    assert.equal(physics.state("ball").position.y, 10, "a character move must not integrate other bodies");
    assert.equal(physics.state("ball").linearVelocity.y, 0);
  } finally {
    physics.dispose();
  }
});

test("moveCharacter collides with a wall added after the last step", async () => {
  const physics = await RapierPhysicsWorld.create({ gravity: { x: 0, y: 0, z: 0 } });
  try {
    physics.addKinematicCharacter({ id: "player", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    physics.step();
    physics.addFixedBox({
      id: "wall",
      position: { x: 2, y: 1, z: 0 },
      halfExtents: { x: 0.25, y: 2, z: 2 },
    });

    const result = physics.moveCharacter("player", { x: 4, y: 0, z: 0 });

    assert.equal(result.collided, true, "the wall added after the last step must block the character");
    assert.ok(result.actual.x < 1.75, `passed through the wall: actual.x=${result.actual.x}`);
  } finally {
    physics.dispose();
  }
});

test("moveCharacter collides with a wall teleported by setBodyTranslation since the last step", async () => {
  const physics = await RapierPhysicsWorld.create({ gravity: { x: 0, y: 0, z: 0 } });
  try {
    physics.addFixedBox({ id: "wall", position: { x: 50, y: 1, z: 0 }, halfExtents: { x: 0.25, y: 2, z: 2 } });
    physics.addKinematicCharacter({ id: "player", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    physics.step();
    physics.setBodyTranslation("wall", { x: 2, y: 1, z: 0 });

    const result = physics.moveCharacter("player", { x: 4, y: 0, z: 0 });

    assert.equal(result.collided, true, "the teleported wall must block the character");
    assert.ok(result.actual.x < 1.75, `passed through the wall: actual.x=${result.actual.x}`);
  } finally {
    physics.dispose();
  }
});

test("two consecutive moveCharacter calls see the first call's new position", async () => {
  const physics = await RapierPhysicsWorld.create({ gravity: { x: 0, y: 0, z: 0 } });
  try {
    physics.addFixedBox({ id: "wall", position: { x: 4, y: 1, z: 0 }, halfExtents: { x: 0.25, y: 2, z: 2 } });
    physics.addKinematicCharacter({ id: "player", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    physics.step();

    const first = physics.moveCharacter("player", { x: 3, y: 0, z: 0 });
    assert.equal(first.collided, false);
    const second = physics.moveCharacter("player", { x: 3, y: 0, z: 0 });

    assert.equal(second.collided, true, "the character is already at x=3, the wall face is at 3.75");
    assert.ok(second.actual.x < 0.5, `second move must be clipped near the wall, got ${second.actual.x}`);
    assert.ok(physics.state("player").position.x < 3.75);
  } finally {
    physics.dispose();
  }
});

// #286 point 3 (review of #280): removal staleness and "moveCharacter never integrates".

test("moveCharacter no longer collides with a wall that was remove()d since the last step", async () => {
  const physics = await RapierPhysicsWorld.create({ gravity: { x: 0, y: 0, z: 0 } });
  try {
    physics.addFixedBox({ id: "wall", position: { x: 2, y: 1, z: 0 }, halfExtents: { x: 0.25, y: 2, z: 2 } });
    physics.addKinematicCharacter({ id: "player", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    physics.step();
    const blocked = physics.moveCharacter("player", { x: 4, y: 0, z: 0 });
    assert.equal(blocked.collided, true, "sanity: the wall blocks before it is removed");
    physics.setBodyTranslation("player", { x: 0, y: 1, z: 0 });

    physics.remove("wall");
    const free = physics.moveCharacter("player", { x: 4, y: 0, z: 0 });

    assert.equal(free.collided, false, "a removed wall must not keep blocking the character");
    assert.ok(Math.abs(free.actual.x - 4) < 1e-4, `expected the full move, got ${free.actual.x}`);
    assert.equal(physics.stats().fixedSteps, 1, "neither remove() nor moveCharacter() counts as a fixed step");
  } finally {
    physics.dispose();
  }
});

test("moveCharacter twice never integrates a falling dynamic body", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    physics.addDynamicBody({ id: "ball", position: { x: 0, y: 10, z: 0 }, shape: "sphere", radius: 0.5 });
    physics.addKinematicCharacter({ id: "player", position: { x: 5, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    for (let i = 0; i < 5; i++) physics.step();
    const before = physics.state("ball");
    assert.ok(before.position.y < 10, "sanity: the ball is falling");
    assert.ok(before.linearVelocity.y < 0, "sanity: the ball has downward velocity");

    physics.moveCharacter("player", { x: 1, y: 0, z: 0 });
    const middle = physics.state("ball");
    physics.moveCharacter("player", { x: 1, y: 0, z: 0 });
    const after = physics.state("ball");

    assert.deepEqual(middle.position, before.position, "first move must not advance the ball");
    assert.deepEqual(after.position, before.position, "second move must not advance the ball");
    assert.deepEqual(after.linearVelocity, before.linearVelocity, "velocity is untouched by character moves");
    assert.equal(physics.stats().fixedSteps, 5);
  } finally {
    physics.dispose();
  }
});
