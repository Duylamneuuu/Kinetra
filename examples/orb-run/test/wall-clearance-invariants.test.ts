import assert from "node:assert/strict";
import { test } from "node:test";

import {
  circleHitsWall,
  distanceToWall,
  resolveWallMotion,
  signedDistanceToWall,
  type OrbRunWall,
} from "../src/walls.js";

// Follow-ups to the review of #509 (slice 34): the per-step clearance property,
// the touching edge, and distanceToWall agreeing with signedDistanceToWall.

const wall = (entityId: string, x: number, z: number, halfWidth: number, halfDepth: number): OrbRunWall => ({
  entityId,
  x,
  z,
  halfWidth,
  halfDepth,
});

const RADIUS = 0.4;

/** The rule of `resolveWallMotion`, stated from the outside: a step may only leave walls it started in, never deeper. */
function assertStepRespectsEveryWall(
  walls: readonly OrbRunWall[],
  before: { x: number; z: number },
  after: { x: number; z: number },
  label: string,
): void {
  for (const w of walls) {
    if (!circleHitsWall([w], after.x, after.z, RADIUS)) continue;
    assert.equal(
      circleHitsWall([w], before.x, before.z, RADIUS),
      true,
      `${label}: ended overlapping ${w.entityId} without having overlapped it before`,
    );
    assert.ok(
      signedDistanceToWall(w, after.x, after.z) >= signedDistanceToWall(w, before.x, before.z) - 1e-12,
      `${label}: went deeper into ${w.entityId}`,
    );
  }
}

test("the L-shaped escape never takes the player deeper into either wall, step by step", () => {
  const walls = [wall("a", 0, 0, 1, 0.5), wall("b", 0.5, 0.75, 0.5, 1)];
  let position = { x: 0.5, z: 0.3 };
  for (let step = 0; step < 80; step += 1) {
    const next = resolveWallMotion(walls, position, { x: position.x + 0.1, z: position.z - 0.1 }, RADIUS);
    assertStepRespectsEveryWall(walls, position, next, `step ${step}`);
    position = next;
  }
  assert.equal(circleHitsWall(walls, position.x, position.z, RADIUS), false);
});

test("a seeded random walk among three walls never violates the per-wall clearance rule", () => {
  const walls = [wall("a", 0, 0, 1, 0.6), wall("b", 1.4, 0.2, 0.5, 1.2), wall("c", -0.8, 1.3, 0.7, 0.4)];
  // Deterministic LCG so a failure reproduces exactly.
  let seed = 20261013;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  let position = { x: 0.4, z: 0.2 }; // inside wall a
  assert.equal(circleHitsWall(walls, position.x, position.z, RADIUS), true, "the walk starts inside a wall");
  let overlappedInside = 0;
  for (let step = 0; step < 2000; step += 1) {
    const target = { x: position.x + (random() - 0.5) * 0.5, z: position.z + (random() - 0.5) * 0.5 };
    const next = resolveWallMotion(walls, position, target, RADIUS);
    assertStepRespectsEveryWall(walls, position, next, `random step ${step}`);
    if (circleHitsWall(walls, next.x, next.z, RADIUS)) overlappedInside += 1;
    position = next;
  }
  assert.ok(overlappedInside > 0, "at least one step ended inside a wall's margin, so the overlap branch ran");
});

test("stepping up to the exact touching distance is allowed, a hair closer is not", () => {
  const walls = [wall("a", 0, 0, 1, 1)];
  const radius = 0.5; // binary-exact numbers: no rounding in the test itself
  const from = { x: 2, z: 0 };
  assert.deepEqual(resolveWallMotion(walls, from, { x: 1.5, z: 0 }, radius), { x: 1.5, z: 0 }, "touching is not overlapping");
  assert.deepEqual(resolveWallMotion(walls, from, { x: 1.5 - 1e-6, z: 0 }, radius), from, "1 micrometre inside is refused");
  // The 1e-9 tolerance of the overlap test: sub-nanometre penetration still counts as touching.
  const sliver = { x: 1.5 - 5e-10, z: 0 };
  assert.deepEqual(resolveWallMotion(walls, from, sliver, radius), sliver);
});

test("touching wall B while easing off wall A is allowed, one step further in is not", () => {
  const walls = [wall("a", 0, 0, 1, 2), wall("b", 2.5, 0, 0.5, 2)];
  const from = { x: 1.1, z: 0 }; // inside A's 0.4 m margin, 0.9 m from B's west face (x = 2)
  assert.deepEqual(resolveWallMotion(walls, from, { x: 1.6, z: 0 }, RADIUS), { x: 1.6, z: 0 }, "exactly 0.4 m from B");
  assert.deepEqual(resolveWallMotion(walls, from, { x: 1.7, z: 0 }, RADIUS), from, "0.3 m from B overlaps it");
});

test("distanceToWall is the signed distance clamped at zero, everywhere", () => {
  const w = wall("a", 1, -2, 1.5, 0.5);
  for (let ix = -8; ix <= 8; ix += 1) {
    for (let iz = -8; iz <= 8; iz += 1) {
      const x = ix * 0.75;
      const z = iz * 0.75 - 2;
      assert.equal(distanceToWall(w, x, z), Math.max(signedDistanceToWall(w, x, z), 0), `(${x}, ${z})`);
    }
  }
  assert.ok(signedDistanceToWall(w, 1, -2) < 0, "inside is negative");
  assert.equal(signedDistanceToWall(w, 2.5, -2), 0, "on the face is zero");
  assert.equal(signedDistanceToWall(w, 5, 2), Math.hypot(2.5, 3.5), "off a corner is the Euclidean distance");
});
