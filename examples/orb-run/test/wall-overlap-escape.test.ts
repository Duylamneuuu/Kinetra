import assert from "node:assert/strict";
import { test } from "node:test";

import { ORB_RUN_PLAYER_RADIUS, circleHitsWall, resolveWallMotion, type OrbRunWall } from "../src/walls.js";

const wall = (x: number, z: number, halfWidth: number, halfDepth: number, entityId = "w"): OrbRunWall => ({
  entityId,
  x,
  z,
  halfWidth,
  halfDepth,
});

test("a free player still slides along a wall exactly as before", () => {
  const walls = [wall(2, 0, 0.5, 3)];
  // Walking +x into the wall at x=1.5 is refused on x; the z part goes through.
  const moved = resolveWallMotion(walls, { x: 0.9, z: 0 }, { x: 1.5, z: 0.5 });
  assert.deepEqual(moved, { x: 0.9, z: 0.5 });
  assert.equal(circleHitsWall(walls, moved.x, moved.z), false);
});

test("a player a wall was authored on top of can walk out instead of being frozen", () => {
  const walls = [wall(0, 0, 1, 1)];
  let position = { x: 0.8, z: 0 };
  assert.equal(circleHitsWall(walls, position.x, position.z), true, "starts overlapping");
  for (let step = 0; step < 30; step += 1) {
    position = resolveWallMotion(walls, position, { x: position.x + 0.1, z: position.z });
  }
  assert.ok(position.x > 1 + ORB_RUN_PLAYER_RADIUS - 1e-9, `escaped to the east edge, x=${position.x}`);
  assert.equal(circleHitsWall(walls, position.x, position.z), false);
});

test("an overlapping player is never pushed deeper into the wall", () => {
  const walls = [wall(0, 0, 1, 1)];
  const from = { x: 0.8, z: 0 };
  const deeper = resolveWallMotion(walls, from, { x: 0.3, z: 0 });
  assert.deepEqual(deeper, from, "moving towards the centre is refused");
  const sideways = resolveWallMotion(walls, from, { x: 0.8, z: 0.3 });
  assert.equal(sideways.x, 0.8);
  assert.ok(sideways.z >= 0, "sliding along the nearest edge is allowed");
});

test("a player at the exact centre of a square wall can still leave", () => {
  const walls = [wall(0, 0, 1, 1)];
  let position = { x: 0, z: 0 };
  for (let step = 0; step < 60; step += 1) {
    position = resolveWallMotion(walls, position, { x: position.x + 0.1, z: position.z });
  }
  assert.equal(circleHitsWall(walls, position.x, position.z), false, `escaped, x=${position.x}`);
});

test("a free player is never allowed to step into a wall", () => {
  const walls = [wall(0, 0, 1, 1)];
  const from = { x: 1.5, z: 0 };
  assert.equal(circleHitsWall(walls, from.x, from.z), false);
  const moved = resolveWallMotion(walls, from, { x: 0.8, z: 0 });
  assert.deepEqual(moved, from);
});

test("no walls returns the target unchanged", () => {
  assert.deepEqual(resolveWallMotion([], { x: 0, z: 0 }, { x: 3, z: -2 }), { x: 3, z: -2 });
});
