import assert from "node:assert/strict";
import test from "node:test";

import { RecastNavMesh } from "../src/index.js";

// Ground plane of 10x10 units centered at (0, 0, 0)
const positions = [
  -5, 0, -5,
   5, 0, -5,
   5, 0,  5,
  -5, 0,  5,
];
const indices = [0, 2, 1, 0, 3, 2];

test("bakes, queries, serializes and reloads a synthetic navmesh", async () => {
  const nav = await RecastNavMesh.bake({ positions, indices });
  try {
    // 1. Path computation across the ground plane
    const pathResult = nav.computePath(
      { x: -3, y: 0, z: -3 },
      { x: 3, y: 0, z: 3 },
    );
    assert.equal(pathResult.success, true);
    assert.equal(pathResult.status, "complete");
    assert.ok(pathResult.points.length >= 2, "Path should contain at least start and end waypoints");
    assert.ok(Math.abs(pathResult.points[0]!.x - (-3)) < 0.5);
    assert.ok(Math.abs(pathResult.points.at(-1)!.x - 3) < 0.5);

    // 2. Closest point query with elevated test coordinates (resolving historical PR #26 query extent issue)
    // Point at (0, 2, 0) is 2m above ground; with default extents [2, 4, 2], it projects to y ~ 0
    const closestElevated = nav.closestPoint({ x: 0, y: 2, z: 0 });
    assert.ok(
      Math.abs(closestElevated.y) <= 0.25,
      `Expected closest point y within cellHeight voxel tolerance (~0.2), got ${closestElevated.y}`,
    );

    // 3. Binary serialization round-trip
    const bytes = nav.toBytes();
    assert.ok(bytes.byteLength > 0, "Serialized navmesh must contain binary data");

    const restored = await RecastNavMesh.fromBytes(bytes);
    try {
      const restoredClosest = restored.closestPoint({ x: 0, y: 2.5, z: 0 }, {
        halfExtents: { x: 2, y: 5, z: 2 },
      });
      assert.ok(Math.abs(restoredClosest.y) <= 0.25);

      const restoredPath = restored.computePath(
        { x: -3, y: 0, z: -3 },
        { x: 3, y: 0, z: 3 },
      );
      assert.equal(restoredPath.success, true);
      assert.equal(restoredPath.points.length, pathResult.points.length);
    } finally {
      restored.dispose();
      assert.equal(restored.disposed, true);
    }
  } finally {
    nav.dispose();
    assert.equal(nav.disposed, true);
  }
});

test("navmesh disposal is clean, safe and idempotent", async () => {
  const nav = await RecastNavMesh.bake({ positions, indices });
  assert.equal(nav.disposed, false);

  nav.dispose();
  assert.equal(nav.disposed, true);

  // Calling dispose again is safe and idempotent
  nav.dispose();
  assert.equal(nav.disposed, true);

  // Queries after disposal throw structured descriptive errors
  assert.throws(
    () => nav.closestPoint({ x: 0, y: 0, z: 0 }),
    /already been disposed/,
  );
  assert.throws(
    () => nav.computePath({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }),
    /already been disposed/,
  );
  assert.throws(
    () => nav.toBytes(),
    /already been disposed/,
  );
});

// Two disconnected 4x4 islands separated by a 4-unit gap on X.
const islandPositions = [
  -6, 0, -2, -2, 0, -2, -2, 0, 2, -6, 0, 2,
   2, 0, -2,  6, 0, -2,  6, 0, 2,  2, 0, 2,
];
const islandIndices = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6];

test("path to an unreachable island reports a partial path instead of complete", async () => {
  const nav = await RecastNavMesh.bake({ positions: islandPositions, indices: islandIndices });
  try {
    const result = nav.computePath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
    assert.equal(result.status, "partial");
    assert.equal(result.success, false);
    assert.ok(result.points.length >= 1, "partial path keeps the reachable prefix");
    assert.ok(result.points.at(-1)!.x < -1, `partial path must end on the start island, got x=${result.points.at(-1)!.x}`);

    const reachable = nav.computePath({ x: 3, y: 0, z: 0 }, { x: 5, y: 0, z: 1 });
    assert.equal(reachable.status, "complete");
    assert.equal(reachable.success, true);
  } finally {
    nav.dispose();
  }
});

test("bake rejects non-finite or non-positive voxel/agent parameters with a structured error", async () => {
  for (const bad of [
    { cellSize: 0 },
    { cellSize: -0.1 },
    { cellHeight: Number.NaN },
    { agentHeight: Number.POSITIVE_INFINITY },
    { agentRadius: -1 },
    { agentMaxClimb: Number.NaN },
    { agentMaxSlope: 120 },
  ]) {
    await assert.rejects(
      () => RecastNavMesh.bake({ positions, indices, ...bad }),
      /NavMesh bake parameter/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("bake rejects malformed geometry before reaching WASM", async () => {
  await assert.rejects(() => RecastNavMesh.bake({ positions: [0, 0], indices: [0, 1, 2] }), /NavMesh bake input/);
  await assert.rejects(() => RecastNavMesh.bake({ positions, indices: [0, 1] }), /NavMesh bake input/);
  await assert.rejects(() => RecastNavMesh.bake({ positions, indices: [0, 1, 9] }), /NavMesh bake input/);
  await assert.rejects(() => RecastNavMesh.bake({ positions: [Number.NaN, ...positions.slice(1)], indices }), /NavMesh bake input/);
});
