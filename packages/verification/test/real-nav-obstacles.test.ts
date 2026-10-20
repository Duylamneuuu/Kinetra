import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  realElectronLaunchArgs,
  type RuntimeQueryResult,
} from "../src/index.js";

const sceneId = stableId("scene", "p7-real-nav-obstacles");

const floorPositions = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5];
const floorIndices = [0, 2, 1, 0, 3, 2];
const start: [number, number, number] = [-4, 0, 0];
const end: [number, number, number] = [4, 0, 0];

function obstacleProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p7-real-nav-obstacles"),
    name: "P7 Real Nav Obstacles",
    scenes: [
      {
        id: sceneId,
        name: "Nav Obstacle Scene",
        entities: [
          {
            id: stableId("entity", "p7-nav-obstacle-floor"),
            name: "Floor",
            components: {
              Primitive: { kind: "box", size: [10, 0.2, 10], color: "#2b3548" },
              Transform: { position: [0, -0.1, 0] },
            },
          },
        ],
      },
    ],
  };
}

function createTestHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    electronArgs: realElectronLaunchArgs(),
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

function pathPoints(query: RuntimeQueryResult): Array<[number, number, number]> {
  const path = query.navigation?.lastPath;
  assert.ok(path, "navigation.lastPath is missing");
  assert.equal(path.status, "complete");
  assert.equal(path.success, true);
  return path.points;
}

function isStraight(points: Array<[number, number, number]>): boolean {
  return points.length >= 2 && points.every((point) => Math.abs(point[2] ?? 0) < 1e-3);
}

test(
  "real Electron runtime detours a tile-cache path around a cylinder and restores it on remove",
  { skip: !canRunRealElectronTests(), timeout: 90_000 },
  async () => {
    const host = createTestHost();
    try {
      await host.start(obstacleProject(), sceneId, 1);
      const baked = await host.bakeNavigation({
        positions: floorPositions,
        indices: floorIndices,
        config: { tileCache: true, maxObstacles: 8 },
      });
      assert.equal(baked.navigation?.hasNavMesh, true);
      assert.equal(baked.navigation?.tileCache, true);
      assert.deepEqual(baked.navigation?.obstacles, []);

      const open = await host.computePathNavigation({ start, end });
      const openPoints = pathPoints(open);
      assert.equal(isStraight(openPoints), true);

      const blocked = await host.addNavigationObstacle({
        type: "cylinder",
        position: [0, 0, 0],
        radius: 1.2,
        height: 2,
      });
      assert.equal(blocked.navigation?.tileCache, true);
      assert.equal(blocked.navigation?.obstacles?.length, 1);
      assert.equal(blocked.navigation?.obstacles?.[0]?.id, "1");
      assert.equal(blocked.navigation?.obstacles?.[0]?.type, "cylinder");

      const detour = await host.computePathNavigation({ start, end });
      const detourPoints = pathPoints(detour);
      assert.equal(isStraight(detourPoints), false);
      assert.equal(
        detourPoints.some((point) => Math.abs(point[2] ?? 0) > 0.5),
        true,
      );

      const cleared = await host.removeNavigationObstacle("1");
      assert.deepEqual(cleared.navigation?.obstacles, []);
      const restored = await host.computePathNavigation({ start, end });
      assert.deepEqual(pathPoints(restored), openPoints);

      await assert.rejects(
        () => host.removeNavigationObstacle("1"),
        /nav\.obstacle\.unknown/,
      );
      const afterUnknown = await host.query();
      assert.deepEqual(afterUnknown.navigation?.obstacles, []);
      assert.deepEqual(afterUnknown.navigation?.lastPath?.points, openPoints);

      const solo = await host.bakeNavigation({
        positions: floorPositions,
        indices: floorIndices,
      });
      assert.equal(solo.navigation?.tileCache, false);
      assert.deepEqual(solo.navigation?.obstacles, []);
      await assert.rejects(
        () =>
          host.addNavigationObstacle({
            type: "cylinder",
            position: [0, 0, 0],
            radius: 1.2,
            height: 2,
          }),
        /nav\.obstaclesUnsupported/,
      );
      const afterSolo = await host.query();
      assert.equal(afterSolo.navigation?.tileCache, false);
      assert.deepEqual(afterSolo.navigation?.obstacles, []);
      assert.equal(afterSolo.running, true);
    } finally {
      await host.close();
    }
  },
);
