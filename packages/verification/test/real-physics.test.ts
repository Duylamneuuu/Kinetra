import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  canRunRealElectronTests,
  realElectronLaunchArgs,
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p7-real-physics");
const floorId = stableId("entity", "p7-floor");
const wallId = stableId("entity", "p7-wall");
const ballId = stableId("entity", "p7-ball");
const playerId = stableId("entity", "p7-player");
const cameraId = stableId("entity", "p7-camera");
const lightId = stableId("entity", "p7-light");

function physicsFixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p7-real-physics"),
    name: "P7 Real Physics Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Physics Acceptance Scene",
        entities: [
          {
            id: floorId,
            name: "Floor",
            components: {
              Primitive: {
                kind: "box",
                size: [20, 0.2, 20],
                color: "#222233",
              },
              Transform: {
                position: [0, -0.1, 0],
              },
              Collider: {
                type: "cuboid",
                halfExtents: [10, 0.1, 10],
              },
            },
          },
          {
            id: wallId,
            name: "Wall",
            components: {
              Primitive: {
                kind: "box",
                size: [0.5, 4, 10],
                color: "#ff4444",
              },
              Transform: {
                position: [2, 2, 0],
              },
              Collider: {
                type: "cuboid",
                halfExtents: [0.25, 2, 5],
              },
            },
          },
          {
            id: ballId,
            name: "Falling Ball",
            components: {
              Primitive: {
                kind: "sphere",
                radius: 0.5,
                color: "#3388ff",
              },
              Transform: {
                position: [-3, 5, 0],
              },
              RigidBody: {
                type: "dynamic",
              },
              Collider: {
                type: "ball",
                radius: 0.5,
              },
            },
          },
          {
            id: playerId,
            name: "Kinematic Player",
            components: {
              Primitive: {
                kind: "box",
                size: [1, 1.5, 1],
                color: "#44ff88",
              },
              Transform: {
                position: [0, 1, 0],
              },
              RigidBody: {
                type: "kinematicPositionBased",
              },
              Collider: {
                type: "capsule",
                halfHeight: 0.5,
                radius: 0.5,
              },
              CharacterBody: {
                offset: 0.05,
              },
            },
          },
          {
            id: cameraId,
            name: "Camera",
            components: {
              Camera: {
                type: "perspective",
                fov: 60,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 3, 8],
              },
            },
          },
          {
            id: lightId,
            name: "Directional Light",
            components: {
              Light: {
                kind: "directional",
                color: "#ffffff",
                intensity: 2.5,
              },
              Transform: {
                position: [5, 8, 5],
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
    electronArgs: realElectronLaunchArgs(),
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

test(
  "real Electron runtime executes deterministic Rapier physics simulation, gravity fall, floor collision, and kinematic character constraint",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: physicsFixtureProject(),
      initialRevision: 1,
    });
    const runner = new AcceptanceRunner(probe);

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p7-real-physics-rapier",
        seed: 42,
        target: "runtime",
        steps: [
          { type: "runtime.start", sceneId },
          { type: "assert.equal", path: "running", expected: true },
          // Initial position assertions: ball starts near y = 5 at x = -3, player starts at x = 0
          {
            type: "assert.near",
            path: "state.byName.Falling Ball.position.0",
            expected: -3,
            tolerance: 0.05,
          },
          {
            type: "assert.near",
            path: "state.byName.Falling Ball.position.1",
            expected: 5,
            tolerance: 0.20,
          },
          {
            type: "assert.equal",
            path: "state.byName.Kinematic Player.position.0",
            expected: 0,
          },
          // Step physics simulation (80 steps of 1/60s = 1.33s), dynamic ball falls and lands on floor
          { type: "runtime.step", steps: 80, deltaSeconds: 1 / 60 },
          // Floor surface is at y = 0; ball radius is 0.5 -> ball lands at y ~ 0.5 and does not fall through
          {
            type: "assert.near",
            path: "state.byName.Falling Ball.position.1",
            expected: 0.5,
            tolerance: 0.15,
          },
          // Inject movement input attempting to move player +4.0 in X direction (towards wall at x = 2)
          {
            type: "input",
            action: "player.moveRight",
            phase: "press",
            value: 4,
          },
          // Wall collider is at x = 2 with halfExtents.x = 0.25 (left face at x = 1.75).
          // Player capsule radius is 0.5, so player is clipped to x ~ 1.20 (< 1.75).
          {
            type: "assert.near",
            path: "state.byName.Kinematic Player.position.0",
            expected: 1.20,
            tolerance: 0.15,
          },
          // Real frame capture proving valid rendered PNG with physics-driven objects
          { type: "assert.screenshotValidPng", minBytes: 1_000 },
          // Ensure zero error logs occurred during physics simulation or character movement
          { type: "assert.logAbsent", minimumLevel: "error" },
          { type: "runtime.stop" },
        ],
      };

      const report = await runner.run(manifest);

      assert.equal(report.passed, true, `Acceptance report failed: ${JSON.stringify(report.steps.filter((s) => !s.passed))}`);
      assert.equal(report.steps.length, 12);
      assert.ok(report.steps.every((step) => step.passed));

      // Verify structured logs recorded character movement input with collision clipping
      const logs = await host.readLogs();
      const inputLog = logs.find(
        (entry) =>
          entry.message === "runtime.input" &&
          entry.data?.action === "player.moveRight",
      );
      assert.ok(inputLog !== undefined, "Input log entry not found");
      assert.equal(inputLog.data?.value, 4);
      if (typeof inputLog.data?.displacementActual === "number") {
        assert.ok(
          inputLog.data.displacementActual < 1.75,
          `Displacement ${inputLog.data.displacementActual} should be < 1.75`,
        );
        assert.ok(
          inputLog.data.displacementActual > 1.0,
          `Displacement ${inputLog.data.displacementActual} should be > 1.0`,
        );
      }
    } finally {
      await host.close();
    }
  },
);
