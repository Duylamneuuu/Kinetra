import assert from "node:assert/strict";
import test from "node:test";

import { NavigationError, RecastNavMesh, type NavObstacle, type PathResult, type Vec3 } from "../src/index.js";

const positions = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5];
const indices = [0, 2, 1, 0, 3, 2];
const start: Vec3 = { x: -4, y: 0, z: 0 };
const end: Vec3 = { x: 4, y: 0, z: 0 };

function roundPoints(path: PathResult): number[][] {
  return path.points.map((point) => [
    Math.round(point.x * 1e4) / 1e4,
    Math.round(point.y * 1e4) / 1e4,
    Math.round(point.z * 1e4) / 1e4,
  ]);
}

function crossesOrigin(path: PathResult): boolean {
  return path.points.some((point) => Math.hypot(point.x, point.z) < 0.5);
}

async function bakeCache(): Promise<RecastNavMesh> {
  return RecastNavMesh.bake({ positions, indices, tileCache: true, maxObstacles: 8 });
}

test("a cylinder blocks the straight path and removing it restores that path", async () => {
  const first = await bakeCache();
  const second = await bakeCache();
  try {
    assert.equal(first.supportsObstacles, true);
    const open = first.computePath(start, end);
    assert.equal(open.status, "complete");
    assert.ok(open.points.every((point) => Math.abs(point.z) < 1e-3));
    assert.deepEqual(roundPoints(second.computePath(start, end)), roundPoints(open));

    const added = first.addObstacle({
      type: "cylinder",
      position: { x: 0, y: 0, z: 0 },
      radius: 1.2,
      height: 2,
    });
    assert.equal(added.id, "1");
    assert.equal(first.obstacles().length, 1);
    const blocked = first.computePath(start, end);
    assert.equal(blocked.status, "complete");
    assert.equal(crossesOrigin(blocked), false);
    assert.ok(blocked.points.some((point) => Math.abs(point.z) > 0.5));
    assert.notDeepEqual(roundPoints(blocked), roundPoints(open));

    second.addObstacle({
      type: "cylinder",
      position: { x: 0, y: 0, z: 0 },
      radius: 1.2,
      height: 2,
    });
    assert.deepEqual(roundPoints(second.computePath(start, end)), roundPoints(blocked));

    first.removeObstacle(added.id);
    assert.deepEqual(first.obstacles(), []);
    assert.deepEqual(roundPoints(first.computePath(start, end)), roundPoints(open));
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("a box obstacle detours the path and a second add gets the next id", async () => {
  const nav = await bakeCache();
  try {
    const open = roundPoints(nav.computePath(start, end));
    const box = nav.addObstacle({
      type: "box",
      position: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 0.4, y: 1, z: 3 },
      angle: 0,
    });
    const cylinder = nav.addObstacle({
      type: "cylinder",
      position: { x: 3, y: 0, z: 3 },
      radius: 0.4,
      height: 1,
    });
    assert.deepEqual([box.id, cylinder.id], ["1", "2"]);
    const blocked = nav.computePath(start, end);
    assert.equal(blocked.success, true);
    assert.notDeepEqual(roundPoints(blocked), open);
    nav.removeObstacle(box.id);
    nav.removeObstacle(cylinder.id);
    assert.deepEqual(roundPoints(nav.computePath(start, end)), open);
    assert.throws(() => nav.removeObstacle(box.id), (error: unknown) => {
      assert.ok(error instanceof NavigationError);
      assert.equal(error.code, "nav.obstacle.unknown");
      assert.match(error.message, /\[nav\.obstacle\.unknown\]/);
      return true;
    });
  } finally {
    nav.dispose();
  }
});

test("a solo bake and a byte snapshot refuse further obstacles", async () => {
  const solo = await RecastNavMesh.bake({ positions, indices });
  try {
    assert.equal(solo.supportsObstacles, false);
    assert.throws(
      () => solo.addObstacle({ type: "cylinder", position: { x: 0, y: 0, z: 0 }, radius: 1, height: 1 }),
      /\[nav\.obstaclesUnsupported\]/,
    );
    const open = solo.computePath(start, end);
    assert.equal(open.success, true);
  } finally {
    solo.dispose();
  }

  const live = await bakeCache();
  try {
    live.addObstacle({ type: "cylinder", position: { x: 0, y: 0, z: 0 }, radius: 1.2, height: 2 });
    const blocked = roundPoints(live.computePath(start, end));
    const snapshot = await RecastNavMesh.fromBytes(live.toBytes());
    try {
      assert.equal(snapshot.supportsObstacles, false);
      assert.deepEqual(roundPoints(snapshot.computePath(start, end)), blocked);
      assert.throws(() => snapshot.removeObstacle("1"), /\[nav\.obstaclesUnsupported\]/);
    } finally {
      snapshot.dispose();
    }
  } finally {
    live.dispose();
  }
});

test("invalid obstacles and bake flags fail before the tile cache changes", async () => {
  const nav = await bakeCache();
  try {
    const before = nav.computePath(start, end);
    const bad: Array<Parameters<RecastNavMesh["addObstacle"]>[0]> = [
      { type: "cylinder", position: { x: 0, y: 0, z: 0 }, radius: 0, height: 1 },
      { type: "cylinder", position: { x: Number.NaN, y: 0, z: 0 }, radius: 1, height: 1 },
      { type: "box", position: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: -1, z: 1 }, angle: 0 },
      { type: "box", position: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 }, angle: Number.POSITIVE_INFINITY },
    ];
    for (const input of bad) {
      assert.throws(() => nav.addObstacle(input), (error: unknown) => {
        assert.ok(error instanceof NavigationError);
        assert.equal(error.code, "nav.obstacle.invalid");
        return true;
      });
    }
    assert.deepEqual(nav.obstacles(), [] as NavObstacle[]);
    assert.deepEqual(roundPoints(nav.computePath(start, end)), roundPoints(before));
  } finally {
    nav.dispose();
  }

  await assert.rejects(
    () => RecastNavMesh.bake({ positions, indices, tileSize: 16 }),
    /require tileCache: true/,
  );
  await assert.rejects(
    () => RecastNavMesh.bake({ positions, indices, tileCache: true, maxObstacles: 0 }),
    /maxObstacles/,
  );
});

test("addObstacle after dispose throws, and the obstacle list is a copy", async () => {
  const nav = await bakeCache();
  const added = nav.addObstacle({
    type: "cylinder",
    position: { x: 1, y: 0, z: 0 },
    radius: 0.3,
    height: 1,
  });
  const listed = nav.obstacles();
  listed[0]!.position.x = 99;
  assert.equal(nav.obstacles()[0]!.position.x, added.position.x);
  nav.dispose();
  assert.throws(() => nav.addObstacle(added), /already been disposed/);
});
