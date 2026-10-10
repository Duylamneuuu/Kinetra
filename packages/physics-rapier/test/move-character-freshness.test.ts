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
