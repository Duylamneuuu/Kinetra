import assert from "node:assert/strict";
import test from "node:test";

import { RecastNavMesh, initNavigation, type Vec3 } from "../src/index.js";

/** Small deterministic PRNG (mulberry32) so property tests are reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pathLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

// 10x10 ground plane centred on the origin.
const plane = {
  positions: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5],
  indices: [0, 2, 1, 0, 3, 2],
};

/**
 * 20x20 ground with a square hole of half-size 2 in the middle, built as four quads
 * (south, east, north, west strips). Walking from one side to the other must go around.
 */
function holedGround(): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number): void => {
    const base = positions.length / 3;
    positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  quad(-10, -10, 10, -2); // south strip
  quad(-10, 2, 10, 10); // north strip
  quad(-10, -2, -2, 2); // west strip
  quad(2, -2, 10, 2); // east strip
  return { positions, indices };
}

test("typed-array geometry bakes to the same navmesh bytes as plain arrays", async () => {
  const fromArrays = await RecastNavMesh.bake(plane);
  const fromTyped = await RecastNavMesh.bake({
    positions: Float32Array.from(plane.positions),
    indices: Uint16Array.from(plane.indices),
  });
  const fromU32 = await RecastNavMesh.bake({
    positions: Float32Array.from(plane.positions),
    indices: Uint32Array.from(plane.indices),
  });
  try {
    assert.deepEqual(fromTyped.toBytes(), fromArrays.toBytes());
    assert.deepEqual(fromU32.toBytes(), fromArrays.toBytes());
  } finally {
    fromArrays.dispose();
    fromTyped.dispose();
    fromU32.dispose();
  }
});

test("baking is deterministic and survives a serialize/restore/serialize cycle", async () => {
  const a = await RecastNavMesh.bake(plane);
  const b = await RecastNavMesh.bake(plane);
  try {
    const bytes = a.toBytes();
    assert.deepEqual(b.toBytes(), bytes, "two bakes of the same input must be byte-identical");

    const restored = await RecastNavMesh.fromBytes(bytes);
    try {
      assert.deepEqual(restored.toBytes(), bytes, "restore then export must reproduce the bytes");
    } finally {
      restored.dispose();
    }
    // The buffer handed out by toBytes is a copy: mutating it must not affect the live mesh.
    bytes.fill(0);
    assert.equal(a.computePath({ x: -3, y: 0, z: -3 }, { x: 3, y: 0, z: 3 }).status, "complete");
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("a path around a hole is longer than the straight line and never crosses the hole", async () => {
  const nav = await RecastNavMesh.bake(holedGround());
  try {
    const start = { x: -6, y: 0, z: 0 };
    const end = { x: 6, y: 0, z: 0 };
    const result = nav.computePath(start, end);
    assert.equal(result.status, "complete");
    assert.equal(result.success, true);
    assert.ok(pathLength(result.points) > 12 + 1, `expected a detour, got length ${pathLength(result.points)}`);
    // No straight-path segment may pass through the hole interior (|x|<2 && |z|<2).
    for (let i = 1; i < result.points.length; i += 1) {
      const a = result.points[i - 1]!;
      const b = result.points[i]!;
      for (let s = 0; s <= 20; s += 1) {
        const t = s / 20;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        assert.ok(!(Math.abs(x) < 1.99 && Math.abs(z) < 1.99), `segment ${i} enters the hole at (${x}, ${z})`);
      }
    }
    // A goal inside the hole snaps to the closest walkable point on the rim.
    const inHole = nav.closestPoint({ x: 0, y: 0, z: 0.5 }, { halfExtents: { x: 4, y: 2, z: 4 } });
    assert.ok(Math.max(Math.abs(inHole.x), Math.abs(inHole.z)) >= 1.5, `closest point ${JSON.stringify(inHole)} is inside the hole`);
  } finally {
    nav.dispose();
  }
});

test("queries far from the mesh fail cleanly instead of returning bogus waypoints", async () => {
  const nav = await RecastNavMesh.bake(plane);
  try {
    const far = { x: 500, y: 0, z: 500 };
    assert.throws(() => nav.closestPoint(far), /No closest point found/);
    const result = nav.computePath({ x: -3, y: 0, z: 0 }, far);
    assert.equal(result.success, false);
    assert.ok(result.status === "failed" || result.status === "partial");
    if (result.status === "failed") assert.deepEqual(result.points, []);
    const fromFar = nav.computePath(far, { x: 3, y: 0, z: 0 });
    assert.equal(fromFar.success, false);
    assert.equal(fromFar.status, "failed");
    assert.deepEqual(fromFar.points, []);
    // A point well below the mesh is outside the search extents; a tighter box also rejects it.
    assert.throws(() => nav.closestPoint({ x: 0, y: -50, z: 0 }), /No closest point found/);
    assert.throws(() => nav.closestPoint({ x: 7, y: 0, z: 0 }, { halfExtents: { x: 1, y: 1, z: 1 } }), /No closest point found/);
    // Widening the horizontal extent finds the rim of the plane.
    const rim = nav.closestPoint({ x: 7, y: 0, z: 0 }, { halfExtents: { x: 3, y: 1, z: 1 } });
    assert.ok(rim.x > 4 && rim.x <= 5, `rim point ${JSON.stringify(rim)}`);
  } finally {
    nav.dispose();
  }
});

test("geometry with no walkable surface rejects the bake with a descriptive error", async () => {
  // A vertical wall (XY plane): nothing is walkable.
  await assert.rejects(
    () => RecastNavMesh.bake({ positions: [0, 0, 0, 5, 0, 0, 5, 5, 0, 0, 5, 0], indices: [0, 1, 2, 0, 2, 3] }),
    /NavMesh bake failed/,
  );
});

test("slopes steeper than agentMaxSlope are not walkable, gentler ones are", async () => {
  // A 10-wide strip on a ramp rising 10 units over `run` units of Z.
  const ramp = (run: number) => ({
    positions: [-5, 0, 0, 5, 0, 0, 5, 10, run, -5, 10, run],
    indices: [0, 2, 1, 0, 3, 2],
  });
  // 10/8 -> ~51 degrees; 10/20 -> ~27 degrees.
  await assert.rejects(() => RecastNavMesh.bake({ ...ramp(8), agentMaxSlope: 30 }), /NavMesh bake failed/);
  const gentle = await RecastNavMesh.bake({ ...ramp(20), agentMaxSlope: 45 });
  try {
    const result = gentle.computePath({ x: 0, y: 0.5, z: 0.5 }, { x: 0, y: 9.5, z: 19 }, { halfExtents: { x: 2, y: 4, z: 2 } });
    assert.equal(result.status, "complete");
    assert.ok(result.points.at(-1)!.y > 8, `path should climb the ramp, ended at y=${result.points.at(-1)!.y}`);
  } finally {
    gentle.dispose();
  }
});

test("agentRadius shrinks the walkable area so a narrow corridor stops being traversable", async () => {
  const corridor = {
    positions: [-10, 0, -0.5, 10, 0, -0.5, 10, 0, 0.5, -10, 0, 0.5],
    indices: [0, 2, 1, 0, 3, 2],
    cellSize: 0.1,
    cellHeight: 0.1,
  };
  const slim = await RecastNavMesh.bake({ ...corridor, agentRadius: 0 });
  try {
    assert.equal(slim.computePath({ x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }).status, "complete");
  } finally {
    slim.dispose();
  }
  // A 1m wide corridor cannot fit an agent with a 1m radius: either the bake is rejected or
  // the resulting mesh is not traversable. It must never claim a complete path.
  let fat: RecastNavMesh | undefined;
  try {
    fat = await RecastNavMesh.bake({ ...corridor, agentRadius: 1 });
  } catch (error) {
    assert.match((error as Error).message, /NavMesh bake failed/);
  }
  if (fat) {
    try {
      assert.notEqual(fat.computePath({ x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }).status, "complete");
    } finally {
      fat.dispose();
    }
  }
});

test("property: random start/end pairs on an open plane produce complete, monotone-length paths", async () => {
  const nav = await RecastNavMesh.bake(plane);
  try {
    const rand = rng(0xc0ffee);
    for (let i = 0; i < 120; i += 1) {
      const start = { x: (rand() - 0.5) * 8, y: 0, z: (rand() - 0.5) * 8 };
      const end = { x: (rand() - 0.5) * 8, y: 0, z: (rand() - 0.5) * 8 };
      const forward = nav.computePath(start, end);
      assert.equal(forward.status, "complete", `case ${i} ${JSON.stringify({ start, end })}`);
      assert.equal(forward.success, true);
      const first = forward.points[0]!;
      const last = forward.points.at(-1)!;
      assert.ok(Math.hypot(first.x - start.x, first.z - start.z) < 0.3, `case ${i}: path starts at ${JSON.stringify(first)}`);
      assert.ok(Math.hypot(last.x - end.x, last.z - end.z) < 0.3, `case ${i}: path ends at ${JSON.stringify(last)}`);
      for (const point of forward.points) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
        assert.ok(Math.abs(point.x) <= 5.001 && Math.abs(point.z) <= 5.001, `case ${i}: waypoint ${JSON.stringify(point)} left the plane`);
      }
      const straight = Math.hypot(end.x - start.x, end.z - start.z);
      // The path can never be shorter than the straight line, and on open ground it is it.
      assert.ok(pathLength(forward.points) >= straight - 0.35, `case ${i}: path shorter than straight line`);
      assert.ok(pathLength(forward.points) <= straight + 0.7, `case ${i}: detour on open ground`);

      const backward = nav.computePath(end, start);
      assert.equal(backward.status, "complete");
      assert.ok(Math.abs(pathLength(backward.points) - pathLength(forward.points)) < 0.05, `case ${i}: asymmetric path length`);
    }
  } finally {
    nav.dispose();
  }
});

test("property: closestPoint is idempotent and always lands on the mesh", async () => {
  const nav = await RecastNavMesh.bake(holedGround());
  try {
    const rand = rng(42);
    const halfExtents = { x: 6, y: 3, z: 6 };
    for (let i = 0; i < 100; i += 1) {
      const probe = { x: (rand() - 0.5) * 18, y: (rand() - 0.5) * 2, z: (rand() - 0.5) * 18 };
      const snapped = nav.closestPoint(probe, { halfExtents });
      assert.ok(Math.abs(snapped.y) < 0.3, `case ${i}: snapped height ${snapped.y}`);
      assert.ok(!(Math.abs(snapped.x) < 1.9 && Math.abs(snapped.z) < 1.9), `case ${i}: ${JSON.stringify(snapped)} is inside the hole`);
      const again = nav.closestPoint(snapped, { halfExtents });
      assert.ok(Math.hypot(again.x - snapped.x, again.z - snapped.z) < 1e-3, `case ${i}: not idempotent`);
    }
  } finally {
    nav.dispose();
  }
});

test("meshes are independent: disposing one does not break another, and concurrent bakes agree", async () => {
  const [a, b, c] = await Promise.all([RecastNavMesh.bake(plane), RecastNavMesh.bake(plane), RecastNavMesh.bake(holedGround())]);
  try {
    assert.deepEqual(a.toBytes(), b.toBytes());
    a.dispose();
    assert.equal(a.disposed, true);
    assert.equal(b.disposed, false);
    assert.equal(b.computePath({ x: -3, y: 0, z: -3 }, { x: 3, y: 0, z: 3 }).status, "complete");
    assert.equal(c.computePath({ x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }).status, "complete");
  } finally {
    a.dispose();
    b.dispose();
    c.dispose();
  }
});

test("initNavigation is idempotent and safe to call concurrently", async () => {
  await Promise.all([initNavigation(), initNavigation(), initNavigation()]);
  await initNavigation();
  const nav = await RecastNavMesh.bake(plane);
  nav.dispose();
});

test("bake rejects geometry that is not array-like with a RangeError, not a raw TypeError", async () => {
  for (const bad of [undefined, null, 5, "abc", {}]) {
    await assert.rejects(
      () => RecastNavMesh.bake({ positions: bad as unknown as number[], indices: plane.indices }),
      RangeError,
      `positions ${String(bad)}`,
    );
    await assert.rejects(
      () => RecastNavMesh.bake({ positions: plane.positions, indices: bad as unknown as number[] }),
      RangeError,
      `indices ${String(bad)}`,
    );
  }
  await assert.rejects(() => RecastNavMesh.bake(null as unknown as { positions: number[]; indices: number[] }), RangeError);
});
