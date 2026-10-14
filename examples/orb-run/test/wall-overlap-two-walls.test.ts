import assert from "node:assert/strict";
import { test } from "node:test";

import { circleHitsWall, resolveWallMotion, type OrbRunWall } from "../src/walls.js";

const wall = (entityId: string, x: number, z: number, halfWidth: number, halfDepth: number): OrbRunWall => ({
  entityId,
  x,
  z,
  halfWidth,
  halfDepth,
});

test("easing off wall A never licenses stepping into wall B (review of #508, finding 1)", () => {
  // The player overlaps A (0.1 m from its east face) and walks east; B's west face is
  // at x = 1.6. Ending at x = 1.3 would overlap B (0.3 m < 0.4) while still raising
  // the minimum clearance over both walls.
  const walls = [wall("a", 0, 0, 1, 2), wall("b", 2.1, 0, 0.5, 2)];
  const from = { x: 1.1, z: 0 };
  assert.equal(circleHitsWall([walls[0] as OrbRunWall], from.x, from.z), true, "starts overlapping A");
  assert.equal(circleHitsWall([walls[1] as OrbRunWall], from.x, from.z), false, "but not B");
  const moved = resolveWallMotion(walls, from, { x: 1.3, z: 0 });
  assert.deepEqual(moved, from, "the step into B is refused");
});

test("an L of two walls that both overlap the player still lets them leave", () => {
  const walls = [wall("a", 0, 0, 1, 0.5), wall("b", 0.5, 0.75, 0.5, 1)];
  let position = { x: 0.5, z: 0.3 };
  assert.equal(walls.filter((w) => circleHitsWall([w], position.x, position.z)).length, 2, "overlaps both");
  for (let step = 0; step < 80; step += 1) {
    position = resolveWallMotion(walls, position, { x: position.x + 0.1, z: position.z - 0.1 });
  }
  assert.equal(circleHitsWall(walls, position.x, position.z), false, `escaped to (${position.x}, ${position.z})`);
});

test("a diagonal step from an overlap uses the updated x for the z axis", () => {
  const walls = [wall("a", 0, 0, 1, 1)];
  const from = { x: 0.8, z: 0.8 };
  const moved = resolveWallMotion(walls, from, { x: 0.9, z: 0.9 });
  assert.deepEqual(moved, { x: 0.9, z: 0.9 }, "both axes move away from the centre");
  const inward = resolveWallMotion(walls, from, { x: 0.7, z: 0.7 });
  // x may slide (the z face is the nearest, so clearance is unchanged); z would go deeper and is refused.
  assert.deepEqual(inward, { x: 0.7, z: 0.8 });
});
