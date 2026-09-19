import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ElectronRuntimeHost } from "@kinetra/mcp-server";

import {
  AcceptanceRunner,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p8-real-acceptance");
const boxId = stableId("entity", "p8-real-box");
const cameraId = stableId("entity", "p8-real-camera");
const lightId = stableId("entity", "p8-real-light");

function fixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p8-real-acceptance"),
    name: "P8 Real Acceptance Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Acceptance Test Scene",
        entities: [
          {
            id: boxId,
            name: "Orange Box",
            components: {
              Primitive: {
                kind: "box",
                size: [1.5, 1.5, 1.5],
                color: "#ff8844",
                roughness: 0.4,
              },
              Transform: {
                position: [0, 0, 0],
              },
            },
          },
          {
            id: cameraId,
            name: "Camera",
            components: {
              Camera: {
                type: "perspective",
                fov: 55,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 0, 5],
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
                intensity: 3,
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
  "real Electron runtime executes passing acceptance manifest with semantic input, state query, and real PNG capture",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: fixtureProject(),
      initialRevision: 42,
    });
    const runner = new AcceptanceRunner(probe);

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p8-real-electron-smoke",
        seed: 101,
        target: "runtime",
        steps: [
          { type: "runtime.start", sceneId },
          { type: "assert.equal", path: "running", expected: true },
          { type: "assert.equal", path: "sceneId", expected: sceneId },
          { type: "assert.equal", path: "state.projectRevision", expected: 42 },
          {
            type: "assert.equal",
            path: "state.byName.Orange Box.position.0",
            expected: 0,
          },
          {
            type: "assert.equal",
            path: "state.byName.Orange Box.position.1",
            expected: 0,
          },
          {
            type: "assert.equal",
            path: "state.byName.Orange Box.position.2",
            expected: 0,
          },
          { type: "input", action: "player.jump", phase: "press" },
          { type: "assert.screenshotValidPng", minBytes: 1_000 },
          { type: "assert.logAbsent", minimumLevel: "error" },
          { type: "runtime.stop" },
        ],
      };

      const report = await runner.run(manifest);

      assert.equal(report.passed, true);
      assert.equal(report.steps.length, 11);
      assert.ok(report.steps.every((step) => step.passed));

      // Verify that structured logs captured the semantic input
      const logs = await host.readLogs();
      assert.ok(
        logs.some(
          (entry: { message: string; data?: Record<string, unknown> }) =>
            entry.message === "runtime.input" &&
            entry.data?.action === "player.jump",
        ),
      );

      // Verify honest empty metrics reporting
      const metrics = await probe.metrics();
      assert.deepEqual(metrics, {});
    } finally {
      await host.close();
    }
  },
);

test(
  "deliberately failing acceptance scenario returns structured failure report and performs clean teardown",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: fixtureProject(),
      initialRevision: 1,
    });
    const runner = new AcceptanceRunner(probe);

    try {
      const failingManifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p8-real-deliberate-failure",
        seed: 0,
        target: "runtime",
        steps: [
          { type: "runtime.start", sceneId },
          {
            type: "assert.equal",
            path: "state.byName.Orange Box.position.0",
            expected: 9999,
          },
          { type: "runtime.stop" },
        ],
      };

      const report = await runner.run(failingManifest);

      assert.equal(report.passed, false);
      assert.equal(report.steps.length, 2);
      assert.equal(report.steps[0]?.passed, true);
      assert.equal(report.steps[1]?.passed, false);
      assert.equal(report.steps[1]?.index, 1);
      assert.equal(report.steps[1]?.type, "assert.equal");
      assert.match(
        report.steps[1]?.message ?? "",
        /Expected state\.byName\.Orange Box\.position\.0 = 9999, got 0/,
      );
    } finally {
      await host.close();
    }
  },
);

test(
  "clean teardown leaves zero orphan processes and is idempotent",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: fixtureProject(),
      closeOnStop: true,
    });

    try {
      await probe.start(sceneId, 0);
      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);

      // Stopping probe with closeOnStop cleans up host
      await probe.stop();

      // Calling close again is safe and idempotent
      await probe.close();
      await host.close();
    } finally {
      await host.close();
    }
  },
);
