import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ElectronRuntimeHost } from "@kinetra/mcp-server";

import {
  AcceptanceRunner,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p6-save-load-scene");
const heroEntityId = stableId("entity", "p6-hero-save-load");
const cameraId = stableId("entity", "p6-camera-save-load");
const lightId = stableId("entity", "p6-light-save-load");

function saveLoadFixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p6-real-save-load"),
    name: "P6 Real Save Load Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Save Load Acceptance Scene",
        entities: [
          {
            id: heroEntityId,
            name: "Hero",
            components: {
              Script: {
                scriptId: "PlayerController",
              },
              Primitive: {
                type: "box",
                size: [1, 1, 1],
                color: "#2ecc71",
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

function assertNoForbiddenObjects(obj: unknown, path = "root"): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "function") {
    throw new Error(`Forbidden function found in save data at ${path}`);
  }
  if (typeof obj === "string") {
    if (/^[A-Za-z]:[\\/]/.test(obj) || obj.startsWith("/home/") || obj.startsWith("/Users/")) {
      throw new Error(`Forbidden absolute machine path found in save data at ${path}: ${obj}`);
    }
  }
  if (typeof obj === "object") {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype && !Array.isArray(obj)) {
      throw new Error(`Forbidden class instance found in save data at ${path}: ${proto?.constructor?.name}`);
    }
    for (const [k, v] of Object.entries(obj)) {
      assertNoForbiddenObjects(v, `${path}.${k}`);
    }
  }
}

test(
  "real Electron runtime executes save -> restart -> load -> verify cycle with real AcceptanceRunner",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => saveLoadFixtureProject(),
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      // Step 1: Manifest that starts, modifies state via semantic input, asserts, and captures save
      const manifest1: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p6-save-capture-acceptance",
        seed: 42,
        target: "runtime",
        steps: [
          { type: "runtime.start", sceneId },
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
          // Inject moveRight
          {
            type: "input",
            action: "player.moveRight",
            phase: "press",
            value: 1,
          },
          { type: "runtime.step", steps: 1 },
          {
            type: "assert.near",
            path: "state.byName.Hero.position.0",
            expected: 1.0,
            tolerance: 0.05,
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.moveCount",
            expected: 1,
          },
          // Inject jump
          {
            type: "input",
            action: "player.jump",
            phase: "press",
          },
          { type: "runtime.step", steps: 1 },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.jumpCount",
            expected: 1,
          },
          // Semantic save operation
          { type: "save.capture", slotId: "acceptance-slot" },
          { type: "runtime.stop" },
        ],
      };

      const runner = new AcceptanceRunner(probe);
      const report1 = await runner.run(manifest1);
      assert.equal(report1.passed, true, `First manifest failed: ${JSON.stringify(report1.steps.filter(s => !s.passed))}`);

      // Verify captured save envelope contract directly
      const captureResult = await host.getSave("acceptance-slot");
      assert.equal(captureResult.success, true);
      assert.ok(captureResult.envelope, "Envelope must exist");
      const envelope = captureResult.envelope as Record<string, unknown>;

      assert.equal(envelope.schemaVersion, 2);
      assert.equal(envelope.slotId, "acceptance-slot");
      assert.ok(typeof envelope.savedAt === "string");

      const data = envelope.data as Record<string, unknown>;
      assert.equal(data.sceneId, sceneId);

      const entities = data.entities as Record<string, Record<string, unknown>>;
      assert.ok(entities[heroEntityId], "Hero entity must be in save");
      const heroSave = entities[heroEntityId];
      const pos = heroSave?.position as [number, number, number];
      assert.ok(Math.abs(pos[0] - 1.0) < 0.05);
      assert.deepEqual(heroSave?.gameplay, {
        moveCount: 1,
        jumpCount: 1,
        lastAction: "player.jump",
      });

      // Assert save contains NO handles, closures, or machine paths
      assertNoForbiddenObjects(envelope);

      // Step 3: Brand new runtime session from original project
      const manifest2: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p6-save-load-acceptance",
        seed: 42,
        target: "runtime",
        steps: [
          // Fresh start from original project document
          { type: "runtime.start", sceneId },

          // Assert pre-load state is fresh/unmodified
          {
            type: "assert.near",
            path: "state.byName.Hero.position.0",
            expected: 0.0,
            tolerance: 0.01,
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

          // Semantic load operation restoring the previously saved gameplay state
          { type: "save.load", slotId: "acceptance-slot" },

          // Assert restored state matches the saved gameplay state
          {
            type: "assert.near",
            path: "state.byName.Hero.position.0",
            expected: 1.0,
            tolerance: 0.05,
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

          // Step simulation after restore to prove continued live execution
          {
            type: "input",
            action: "player.moveRight",
            phase: "press",
            value: 1,
          },
          { type: "runtime.step", steps: 1 },
          {
            type: "assert.near",
            path: "state.byName.Hero.position.0",
            expected: 2.0,
            tolerance: 0.05,
          },
          {
            type: "assert.equal",
            path: "state.byName.Hero.gameplay.state.moveCount",
            expected: 2,
          },

          // Real PNG screenshot after restore
          { type: "assert.screenshotValidPng", minBytes: 1000 },
          { type: "assert.logAbsent", minimumLevel: "error" },
          { type: "runtime.stop" },
        ],
      };

      const report2 = await runner.run(manifest2);
      assert.equal(report2.passed, true, `Second manifest failed: ${JSON.stringify(report2.steps.filter(s => !s.passed))}`);

      // Verify real PNG frame directly
      const frameBytes = await probe.captureFrame();
      assert.ok(frameBytes.length > 1000, `Expected frame > 1000 bytes, got ${frameBytes.length}`);
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.equal(
        Buffer.from(frameBytes.subarray(0, 8)).compare(pngHeader),
        0,
        "Frame must have valid PNG magic header",
      );
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "real Electron runtime performs save migration from synthetic v1 schema and restores into fresh session",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => saveLoadFixtureProject(),
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      await probe.start(sceneId, 1);

      // Synthetic V1 envelope: schemaVersion 1 with legacy 'state' key instead of 'gameplay'
      const v1Envelope = {
        schemaVersion: 1,
        gameVersion: "0.0.1",
        slotId: "legacy-v1-slot",
        savedAt: "2026-09-19T00:00:00.000Z",
        data: {
          sceneId,
          entities: {
            [heroEntityId]: {
              position: [3.5, 0, 0],
              state: {
                moveCount: 7,
                jumpCount: 4,
                lastAction: "player.moveRight",
              },
            },
          },
        },
      };

      // Load synthetic v1 save envelope directly
      const loadResult = await host.loadSave({ envelope: v1Envelope });
      assert.equal(loadResult.success, true);
      assert.equal(loadResult.schemaVersion, 2, "Migrator must advance schemaVersion to 2");

      // Verify runtime query reflects migrated and restored state
      const snapshot = await probe.snapshot();
      const hero = (snapshot.state.byName as Record<string, any>)?.Hero;
      assert.ok(hero);
      assert.ok(Math.abs(hero.position[0] - 3.5) < 0.05, `Expected pos.x near 3.5, got ${hero.position[0]}`);
      assert.equal(hero.gameplay?.state?.moveCount, 7);
      assert.equal(hero.gameplay?.state?.jumpCount, 4);

      // Verify log recorded save.restored with schemaVersion 2
      const logs = await probe.logs();
      const restoreLog = logs.find(l => l.message === "save.restored");
      assert.ok(restoreLog);
      assert.equal(restoreLog.data?.schemaVersion, 2);

      await host.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "deliberate invalid save failure: incompatible schema and corrupt payload return structured error without crashing Electron",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => saveLoadFixtureProject(),
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      await probe.start(sceneId, 1);

      // 1. Incompatible future schema version
      const futureEnvelope = {
        schemaVersion: 999,
        gameVersion: "99.0.0",
        slotId: "future-slot",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {},
        },
      };

      const futureResult = await host.loadSave({ envelope: futureEnvelope });
      assert.equal(futureResult.success, false);
      assert.ok(futureResult.error?.includes("newer than this game build"));

      // 2. Scene mismatch
      const wrongSceneEnvelope = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "wrong-scene-slot",
        savedAt: new Date().toISOString(),
        data: {
          sceneId: "different-scene-id",
          entities: {},
        },
      };

      const wrongSceneResult = await host.loadSave({ envelope: wrongSceneEnvelope });
      assert.equal(wrongSceneResult.success, false);
      assert.ok(wrongSceneResult.error?.includes("does not match active sceneId"));

      // 3. Corrupt/invalid entities record
      const corruptEnvelope = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "corrupt-slot",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {
            [heroEntityId]: {
              position: "invalid-position" as any,
            },
          },
        },
      };

      const corruptResult = await host.loadSave({ envelope: corruptEnvelope });
      assert.equal(corruptResult.success, false);
      assert.ok(corruptResult.error?.includes("Invalid position coordinates"));

      // Assert runtime remains fully alive and state is uncorrupted
      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);
      const hero = (snapshot.state.byName as Record<string, any>)?.Hero;
      assert.ok(Math.abs(hero.position[0] - 0.0) < 0.01);
      assert.equal(hero.gameplay?.state?.moveCount, 0);

      // Assert structured failure logs are captured
      const logs = await probe.logs();
      const failLogs = logs.filter(l => l.message === "save.restoreFailed");
      assert.ok(failLogs.length >= 3);

      await host.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);
