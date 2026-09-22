import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  canRunRealElectronTests,  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p6-gameplay-scene");
const heroEntityId = stableId("entity", "p6-hero-entity");
const cameraId = stableId("entity", "p6-gameplay-camera");
const lightId = stableId("entity", "p6-gameplay-light");

function gameplayFixtureProject(scriptId: string = "PlayerController"): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p6-real-gameplay"),
    name: "P6 Real Gameplay Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Gameplay Acceptance Scene",
        entities: [
          {
            id: heroEntityId,
            name: "Hero",
            components: {
              Script: {
                scriptId,
              },
              Primitive: {
                type: "box",
                size: [1, 1, 1],
                color: "#3498db",
              },
              Transform: {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
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
                position: [0, 2, 5],
                rotation: [-0.2, 0, 0],
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
                intensity: 2.5,
              },
              Transform: {
                position: [3, 5, 4],
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
  "real Electron runtime executes script lifecycle, routes semantic input, advances deterministically, and verifies via AcceptanceRunner",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => gameplayFixtureProject("PlayerController"),
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p6-gameplay-script-acceptance",
        seed: 42,
        target: "runtime",
        steps: [
          // 1. Start scene
          { type: "runtime.start", sceneId },

          // 2. Verify script lifecycle is started and initial state is clean
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.scriptId",
            expected: "PlayerController",
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.lifecycleState",
            expected: "started",
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.updateCount",
            expected: 0,
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.moveCount",
            expected: 0,
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.jumpCount",
            expected: 0,
          },
          {
            type: "assert.near",
            path: "state.byName.Hero.position.0",
            expected: 0.0,
            tolerance: 0.01,
          },

          // 3. Inject semantic input: player.moveRight
          {
            type: "input",
            action: "player.moveRight",
            phase: "press",
            value: 1,
          },

          // 4. Deterministic step
          { type: "runtime.step", steps: 1 },

          // 5. Assert script update executed and position translated along X
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.updateCount",
            expected: 1,
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.moveCount",
            expected: 1,
          },
          {
            type: "assert.near",
            path: "state.byName.Hero.position.0",
            expected: 1.0,
            tolerance: 0.05,
          },

          // 6. Inject semantic input: player.jump
          {
            type: "input",
            action: "player.jump",
            phase: "press",
          },

          // 7. Deterministic step
          { type: "runtime.step", steps: 1 },

          // 8. Assert jump incremented and move count stayed unchanged
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.updateCount",
            expected: 2,
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.moveCount",
            expected: 1,
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.jumpCount",
            expected: 1,
          },

          // 9. Capture real PNG screenshot
          { type: "assert.screenshotValidPng", minBytes: 1_000 },

          // 10. Verify zero unexpected error logs
          { type: "assert.logAbsent", minimumLevel: "error" },

          // 11. Clean stop
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
  "deliberate script failure scenario: unresolvable script produces structured error without crashing runtime",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => gameplayFixtureProject("NonexistentScript"),
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      await probe.start(sceneId, 1);

      // Verify runtime is still running and did not crash
      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);

      const entity = (snapshot.state as any).byName?.Hero;
      assert.ok(entity);
      assert.equal(entity.gameplay?.scriptId, "NonexistentScript");
      assert.equal(entity.gameplay?.lifecycleState, "error");
      assert.ok(entity.gameplay?.error?.includes("NonexistentScript"));

      // Verify structured error log was emitted
      const logs = await probe.logs();
      const errorLog = logs.find(
        (l) => l.level === "error" && l.message === "script.resolveFailed",
      );
      assert.ok(
        errorLog,
        "A structured 'script.resolveFailed' error log must be recorded for unknown script",
      );
      assert.equal(errorLog.data?.scriptId, "NonexistentScript");

      // Verify runtime remains controllable and cleanly stops
      await probe.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "lifecycle proof: scene stop and restart cleanly resets script state and re-executes lifecycle",
  { skip: !canRunRealElectronTests(), timeout: 45_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => gameplayFixtureProject("PlayerController"),
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      // First session: start, move, step
      await probe.start(sceneId, 1);

      // Verify initial lifecycle logs: onCreate and onStart
      let logs = await probe.logs();
      const createLog = logs.find(
        (l) => l.message === "script.lifecycle" && l.data?.phase === "onCreate",
      );
      const startLog = logs.find(
        (l) => l.message === "script.lifecycle" && l.data?.phase === "onStart",
      );
      assert.ok(createLog, "onCreate must be recorded in lifecycle logs");
      assert.ok(startLog, "onStart must be recorded in lifecycle logs");

      // Inject move and step
      await probe.input({ action: "player.moveRight", phase: "press", value: 1 });
      await probe.step(1);

      let snapshot = await probe.snapshot();
      let entity = (snapshot.state as any).byName?.Hero;
      assert.equal(entity?.gameplay?.state?.moveCount, 1);
      assert.ok(Math.abs((entity?.position?.[0] ?? 0) - 1.0) < 0.05);

      // Stop session
      await probe.stop();

      // Verify stop lifecycle logs: onStop and onDestroy
      logs = await probe.logs();
      const stopLog = logs.find(
        (l) => l.message === "script.lifecycle" && l.data?.phase === "onStop",
      );
      const destroyLog = logs.find(
        (l) => l.message === "script.lifecycle" && l.data?.phase === "onDestroy",
      );
      assert.ok(stopLog, "onStop must be recorded in lifecycle logs");
      assert.ok(destroyLog, "onDestroy must be recorded in lifecycle logs");

      // Restart session
      await probe.start(sceneId, 2);
      snapshot = await probe.snapshot();
      entity = (snapshot.state as any).byName?.Hero;
      assert.equal(entity?.gameplay?.lifecycleState, "started");
      assert.equal(entity?.gameplay?.updateCount, 0);
      assert.equal(entity?.gameplay?.state?.moveCount, 0);
      assert.equal(entity?.gameplay?.state?.jumpCount, 0);
      assert.equal(entity?.position?.[0], 0);

      await probe.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);
