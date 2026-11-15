import assert from "node:assert/strict";
import test from "node:test";

import { TileCache } from "@recast-navigation/core";

import { NavigationError, RecastNavMesh, type PathResult, type Vec3 } from "../src/index.js";

const positions = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5];
const indices = [0, 2, 1, 0, 3, 2];
const start: Vec3 = { x: -4, y: 0, z: 0 };
const end: Vec3 = { x: 4, y: 0, z: 0 };

/** The unobstructed path is the straight line along z = 0; a detour bends away from it. */
function isStraight(path: PathResult): boolean {
  return path.points.length > 0 && path.points.every((point) => Math.abs(point.z) < 1e-3);
}

/** Makes the next `count` TileCache.update calls report a failure, then restores the real one. */
function failNextUpdates(count: number): () => void {
  const original = TileCache.prototype.update;
  let remaining = count;
  TileCache.prototype.update = function patched(this: TileCache, ...args: Parameters<TileCache["update"]>) {
    if (remaining > 0) {
      remaining -= 1;
      return { success: false, status: 1, upToDate: false } as ReturnType<TileCache["update"]>;
    }
    return original.apply(this, args);
  };
  return () => {
    TileCache.prototype.update = original;
  };
}

test("removeObstacle whose tile flush fails still drops the obstacle the tile cache already removed", async () => {
  const nav = await RecastNavMesh.bake({ positions, indices, tileCache: true, maxObstacles: 8 });
  try {
    const added = nav.addObstacle({ type: "cylinder", position: { x: 0, y: 0, z: 0 }, radius: 1.2, height: 2 });
    assert.equal(isStraight(nav.computePath(start, end)), false);

    const restore = failNextUpdates(1);
    try {
      assert.throws(
        () => nav.removeObstacle(added.id),
        (error: unknown) => error instanceof NavigationError && error.code === "nav.obstacle.failed",
      );
    } finally {
      restore();
    }

    // The tile cache has already dropped the obstacle; keeping it listed would make a retry
    // hand a stale handle to the cache and report a confusing second failure.
    assert.deepEqual(nav.obstacles(), []);
    assert.throws(
      () => nav.removeObstacle(added.id),
      (error: unknown) => error instanceof NavigationError && error.code === "nav.obstacle.unknown",
    );

    // The next successful flush rebuilds the tiles the failed one left behind.
    nav.addObstacle({ type: "cylinder", position: { x: 0, y: 0, z: 4 }, radius: 0.3, height: 2 });
    assert.equal(isStraight(nav.computePath(start, end)), true);
  } finally {
    nav.dispose();
  }
});
