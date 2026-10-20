import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  realElectronLaunchArgs,
} from "../src/index.js";

const sceneId = stableId("scene", "physics-query");
const floorId = stableId("entity", "physics-query-floor");

function floorProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "physics-query"),
    name: "Physics Query Bridge",
    scenes: [
      {
        id: sceneId,
        name: "Floor",
        entities: [
          {
            id: floorId,
            name: "Floor",
            components: {
              Primitive: { kind: "box", size: [20, 0.2, 20], color: "#222233" },
              Transform: { position: [0, -0.1, 0] },
              Collider: { shape: "box", halfExtents: [10, 0.1, 10] },
            },
          },
        ],
      },
    ],
  };
}

test(
  "live Electron physics.raycast and physics.shapeCast hit the floor and reject a bad shape",
  { skip: !canRunRealElectronTests(), timeout: 90_000 },
  async () => {
    const host = new ElectronRuntimeHost({
      electronArgs: realElectronLaunchArgs(),
      requestTimeoutMs: 30_000,
      ...(process.env.KINETRA_RUNTIME_EXECUTABLE
        ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
        : {}),
    });
    try {
      await host.start(floorProject(), sceneId, 1);
      const ray = await host.raycast({
        origin: { x: 1, y: 4, z: -2 },
        direction: { x: 0, y: -1, z: 0 },
      });
      assert.equal(ray?.entityId, floorId);
      assert.ok(ray && Math.abs(ray.distance - 4) < 1e-2);
      assert.ok(ray && Math.abs(ray.point.y) < 1e-2);
      assert.equal(ray?.startedInside, false);

      const sweep = await host.shapeCast({
        shape: { type: "box", halfExtents: { x: 0.3, y: 0.4, z: 0.3 } },
        origin: { x: 1, y: 0.4, z: -2 },
        direction: { x: 0, y: -1, z: 0 },
      });
      assert.equal(sweep?.entityId, floorId);
      assert.ok(sweep && Math.abs(sweep.distance) < 1e-2, `flush distance ${sweep?.distance}`);
      assert.ok(sweep && Math.abs(sweep.point.y) < 1e-2, `flush point.y ${sweep?.point.y}`);
      assert.ok(sweep && Math.abs(sweep.point.x - 1) < 1e-2);
      assert.ok(sweep && Math.abs((sweep?.normal.y ?? 0) - 1) < 1e-2);

      await assert.rejects(
        () =>
          host.shapeCast({
            shape: { type: "sphere", radius: 0 },
            origin: { x: 0, y: 1, z: 0 },
            direction: { x: 0, y: -1, z: 0 },
          }),
        /shapeCast sphere radius/,
      );
    } finally {
      await host.close();
    }
  },
);
