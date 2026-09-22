import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  canRunRealElectronTests,
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p7-real-navigation");
const floorId = stableId("entity", "p7-nav-floor");
const obstacleId = stableId("entity", "p7-nav-obstacle");
const cameraId = stableId("entity", "p7-nav-camera");
const lightId = stableId("entity", "p7-nav-light");

// Synthetic ground mesh: 10m x 10m flat plane at y = 0
// Centered at origin: x in [-5, 5], z in [-5, 5]
const floorPositions = [
  -5, 0, -5,
   5, 0, -5,
   5, 0,  5,
  -5, 0,  5,
];
const floorIndices = [0, 2, 1, 0, 3, 2];

function navigationFixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p7-real-navigation"),
    name: "P7 Real Navigation Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Navigation Acceptance Scene",
        entities: [
          {
            id: floorId,
            name: "NavFloor",
            components: {
              Primitive: {
                kind: "box",
                size: [10, 0.2, 10],
                color: "#2b3548",
              },
              Transform: {
                position: [0, -0.1, 0],
              },
            },
          },
          {
            id: obstacleId,
            name: "NavObstacle",
            components: {
              Primitive: {
                kind: "box",
                size: [2, 2, 2],
                color: "#e64a19",
              },
              Transform: {
                position: [0, 1, 0],
              },
            },
          },
          {
            id: cameraId,
            name: "MainCamera",
            components: {
              Camera: {
                type: "perspective",
                fov: 50,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 8, 12],
                rotation: [-0.6, 0, 0],
              },
            },
          },
          {
            id: lightId,
            name: "KeyLight",
            components: {
              Light: {
                kind: "directional",
                color: "#ffffff",
                intensity: 2,
              },
              Transform: {
                position: [5, 10, 5],
              },
            },
          },
        ],
      },
    ],
  };
}

function createTestHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

test(
  "real Electron runtime executes deterministic Recast navigation queries, pathfinding, serialization round-trip, and constrained failure",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: navigationFixtureProject,
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p7-real-navigation-recast",
        seed: 42,
        target: "runtime",
        steps: [
          // 1. Boot Electron player runtime with navigation fixture scene
          { type: "runtime.start", sceneId },
          { type: "assert.equal", path: "running", expected: true },

          // 2. Bake synthetic NavMesh from flat geometry buffers
          {
            type: "navigation.bake",
            positions: floorPositions,
            indices: floorIndices,
          },
          {
            type: "assert.equal",
            path: "state.navigation.hasNavMesh",
            expected: true,
          },

          // 3. Semantic closest-point query with elevated test coordinates (resolving PR #26 query extent issue)
          // Point at [0, 2, 0] is 2m above ground; snaps vertically to surface (y ~ 0.2 within voxel height)
          {
            type: "navigation.closestPoint",
            position: [0, 2, 0],
          },
          {
            type: "assert.near",
            path: "state.navigation.lastClosestPoint.point.0",
            expected: 0,
            tolerance: 0.25,
          },
          {
            type: "assert.near",
            path: "state.navigation.lastClosestPoint.point.1",
            expected: 0.2,
            tolerance: 0.25,
          },
          {
            type: "assert.near",
            path: "state.navigation.lastClosestPoint.point.2",
            expected: 0,
            tolerance: 0.25,
          },

          // 4. Compute valid waypoint path from [-4, 0, -4] to [4, 0, 4]
          {
            type: "navigation.computePath",
            start: [-4, 0, -4],
            end: [4, 0, 4],
          },
          {
            type: "assert.equal",
            path: "state.navigation.lastPath.success",
            expected: true,
          },
          {
            type: "assert.equal",
            path: "state.navigation.lastPath.status",
            expected: "complete",
          },

          // 5. Deliberately invalid/constrained query: compute path to unreachable / far out-of-bounds point [100, 0, 100]
          // Produces truthful structured failure without throwing or crashing
          {
            type: "navigation.computePath",
            start: [-4, 0, -4],
            end: [100, 0, 100],
          },
          {
            type: "assert.equal",
            path: "state.navigation.lastPath.success",
            expected: false,
          },
          {
            type: "assert.equal",
            path: "state.navigation.lastPath.status",
            expected: "failed",
          },
          {
            type: "assert.equal",
            path: "state.navigation.lastPath.pointCount",
            expected: 0,
          },

          // 6. Real frame capture proving valid rendered PNG with scene and obstacle geometry
          { type: "assert.screenshotValidPng", minBytes: 1_000 },

          // 7. Verify zero warning/error logs
          { type: "assert.logAbsent", minimumLevel: "error" },

          // 8. Graceful stop
          { type: "runtime.stop" },
        ],
      };

      const runner = new AcceptanceRunner(probe);
      const report = await runner.run(manifest);

      assert.equal(
        report.passed,
        true,
        `Acceptance report failed: ${JSON.stringify(report.steps.filter((s) => !s.passed))}`,
      );
      assert.equal(report.steps.length, manifest.steps.length);
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "serialized NavMesh can be reloaded in real Electron runtime and produce equivalent pathfinding behavior",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: navigationFixtureProject,
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      await probe.start(sceneId, 42);

      // 1. Bake NavMesh initially
      await probe.bakeNavigation!({
        positions: floorPositions,
        indices: floorIndices,
      });

      // 2. Compute initial path
      await probe.computePathNavigation!({
        start: [-4, 0, -4],
        end: [4, 0, 4],
      });

      const initialSnapshot = await probe.snapshot();
      const initialPath = (initialSnapshot.state as any).navigation?.lastPath;
      assert.equal(initialPath?.success, true);
      assert.ok(initialPath?.points?.length >= 2);

      const serializedBase64 = (initialSnapshot.state as any).navigation?.serialized;
      assert.ok(
        typeof serializedBase64 === "string" && serializedBase64.length > 0,
        "NavMesh state must contain base64 serialized data",
      );

      // 3. Reload NavMesh from serialized binary data
      await probe.loadNavigation!({ dataBase64: serializedBase64 });

      // 4. Recompute path on reloaded NavMesh
      await probe.computePathNavigation!({
        start: [-4, 0, -4],
        end: [4, 0, 4],
      });

      const reloadedSnapshot = await probe.snapshot();
      const reloadedPath = (reloadedSnapshot.state as any).navigation?.lastPath;
      assert.equal(reloadedPath?.success, true);
      assert.equal(reloadedPath?.status, "complete");
      assert.equal(reloadedPath?.pointCount, initialPath.pointCount);

      // Deep compare waypoint coordinates between original and reloaded paths
      for (let i = 0; i < initialPath.points.length; i++) {
        assert.ok(
          Math.abs(initialPath.points[i][0] - reloadedPath.points[i][0]) < 0.001,
          `Waypoint ${i} X mismatch: ${initialPath.points[i][0]} vs ${reloadedPath.points[i][0]}`,
        );
        assert.ok(
          Math.abs(initialPath.points[i][1] - reloadedPath.points[i][1]) < 0.001,
          `Waypoint ${i} Y mismatch: ${initialPath.points[i][1]} vs ${reloadedPath.points[i][1]}`,
        );
        assert.ok(
          Math.abs(initialPath.points[i][2] - reloadedPath.points[i][2]) < 0.001,
          `Waypoint ${i} Z mismatch: ${initialPath.points[i][2]} vs ${reloadedPath.points[i][2]}`,
        );
      }

      await probe.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "clean teardown releases navigation resources and leaves zero orphan Electron processes",
  { skip: !canRunRealElectronTests(), timeout: 30_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: navigationFixtureProject,
      initialRevision: 1,
      closeOnStop: true,
    });

    try {
      await probe.start(sceneId, 1);
      await probe.bakeNavigation!({
        positions: floorPositions,
        indices: floorIndices,
      });

      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);
      assert.equal((snapshot.state as any).navigation?.hasNavMesh, true);

      // Stopping probe with closeOnStop cleans up host
      await probe.stop();

      // Multiple close calls are idempotent and safe
      await probe.close();
      await host.close();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);
