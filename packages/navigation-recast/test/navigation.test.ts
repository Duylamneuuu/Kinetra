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

test("queries reject non-finite positions and invalid halfExtents with RangeError instead of reaching WASM", async () => {
  const nav = await RecastNavMesh.bake({ positions, indices });
  try {
    const ok = { x: 0, y: 0, z: 0 };
    for (const bad of [
      { x: Number.NaN, y: 0, z: 0 },
      { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
      { x: 0, y: 0, z: Number.NEGATIVE_INFINITY },
      { x: "1", y: 0, z: 0 } as unknown as { x: number; y: number; z: number },
      null as unknown as { x: number; y: number; z: number },
    ]) {
      assert.throws(() => nav.closestPoint(bad), RangeError, `closestPoint ${JSON.stringify(bad)}`);
      assert.throws(() => nav.computePath(bad, ok), RangeError, `computePath start ${JSON.stringify(bad)}`);
      assert.throws(() => nav.computePath(ok, bad), RangeError, `computePath end ${JSON.stringify(bad)}`);
    }
    for (const halfExtents of [
      { x: Number.NaN, y: 4, z: 2 },
      { x: 2, y: 0, z: 2 },
      { x: 2, y: 4, z: -1 },
      { x: Number.POSITIVE_INFINITY, y: 4, z: 2 },
    ]) {
      assert.throws(() => nav.closestPoint(ok, { halfExtents }), /halfExtents/);
      assert.throws(() => nav.computePath(ok, { x: 1, y: 0, z: 1 }, { halfExtents }), /halfExtents/);
    }
    // Valid queries still work after rejected ones (no corrupted query state).
    assert.equal(nav.computePath({ x: -3, y: 0, z: -3 }, { x: 3, y: 0, z: 3 }).status, "complete");
  } finally {
    nav.dispose();
  }
});

test("fromBytes rejects empty, non-Uint8Array and garbage input with a descriptive error", async () => {
  await assert.rejects(() => RecastNavMesh.fromBytes(new Uint8Array(0)), /non-empty Uint8Array/);
  await assert.rejects(() => RecastNavMesh.fromBytes([1, 2, 3] as unknown as Uint8Array), /non-empty Uint8Array/);
  await assert.rejects(() => RecastNavMesh.fromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /Failed to import NavMesh|non-empty/);
  await assert.rejects(() => RecastNavMesh.fromBytes(new Uint8Array(512).fill(0xff)), /Failed to import NavMesh|non-empty/);

  // A truncated valid navmesh must not import as a usable mesh.
  const nav = await RecastNavMesh.bake({ positions, indices });
  try {
    const bytes = nav.toBytes();
    await assert.rejects(() => RecastNavMesh.fromBytes(bytes.slice(0, Math.floor(bytes.byteLength / 2))), /Failed to import NavMesh|non-empty/);
    // Right size but wrong magic / trailing bytes are refused too.
    const wrongMagic = bytes.slice();
    wrongMagic[0] = 0;
    await assert.rejects(() => RecastNavMesh.fromBytes(wrongMagic), /bad magic/);
    const trailing = new Uint8Array(bytes.byteLength + 3);
    trailing.set(bytes);
    await assert.rejects(() => RecastNavMesh.fromBytes(trailing), /trailing bytes/);
    // And the original bytes still round-trip afterwards.
    const again = await RecastNavMesh.fromBytes(bytes);
    again.dispose();
  } finally {
    nav.dispose();
  }
});
