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

const sceneId = stableId("scene", "p6-save-load-scene");
const heroEntityId = stableId("entity", "p6-hero-save-load");
const cameraId = stableId("entity", "p6-camera-save-load");
const lightId = stableId("entity", "p6-light-save-load");
const readOnlyNpcId = stableId("entity", "p6-readonly-npc");
const throwingEntityId = stableId("entity", "p6-throwing-entity");
const adversarialEntityId = stableId("entity", "p6-adversarial-entity");
const legacyNpcId = stableId("entity", "p6-legacy-npc");

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

function saveLoadAtomicityFixtureProject(): ProjectDocument {
  const base = saveLoadFixtureProject();
  return {
    ...base,
    scenes: [
      {
        ...base.scenes[0]!,
        entities: [
          ...base.scenes[0]!.entities,
          {
            id: readOnlyNpcId,
            name: "ReadOnlyNpc",
            components: {
              Script: {
                scriptId: "ReadOnlyScript",
              },
              Transform: {
                position: [5, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
            },
          },
          {
            id: throwingEntityId,
            name: "ThrowingEntity",
            components: {
              Script: {
                scriptId: "ThrowingRestoreScript",
              },
              Transform: {
                position: [-5, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
            },
          },
          {
            id: adversarialEntityId,
            name: "AdversarialEntity",
            components: {
              Script: {
                scriptId: "AdversarialMutationScript",
              },
              Transform: {
                position: [1, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
            },
          },
          {
            id: legacyNpcId,
            name: "LegacyNpc",
            components: {
              Script: {
                scriptId: "LegacyRestoreScript",
              },
              Transform: {
                position: [7, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
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
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
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
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
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
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
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

test(
  "all-or-nothing save restoration atomicity: malformed gameplay, unsupported script, and commit throw apply zero mutations and rollback",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => saveLoadAtomicityFixtureProject(),
      initialRevision: 1,
      closeOnStop: false,
      testScriptPreset: "save-load-atomicity",
    });

    try {
      await probe.start(sceneId, 1);

      // Verify baseline initial states
      let snapshot = await probe.snapshot();
      let hero = (snapshot.state.byName as Record<string, any>)?.Hero;
      let camera = (snapshot.state.byName as Record<string, any>)?.MainCamera;
      let npc = (snapshot.state.byName as Record<string, any>)?.ReadOnlyNpc;
      let throwing = (snapshot.state.byName as Record<string, any>)?.ThrowingEntity;
      let adv = (snapshot.state.byName as Record<string, any>)?.AdversarialEntity;
      let legacyNpc = (snapshot.state.byName as Record<string, any>)?.LegacyNpc;

      assert.equal(hero.position[0], 0);
      assert.equal(hero.gameplay?.state?.moveCount, 0);
      assert.equal(camera.position[1], 2);
      assert.equal(npc.position[0], 5);
      assert.equal(throwing.position[0], -5);
      assert.equal(adv.position[0], 1);
      assert.equal(adv.gameplay?.state?.value, 5);
      assert.equal(legacyNpc.position[0], 7);
      assert.equal(legacyNpc.gameplay?.state?.legacyValue, 100);

      // --- Case 0: Adversarial mutation-before-throw test ---
      // initial script state: value = 5, position.x = 1
      // save requests: position.x = 20, value = 99, throwAfterMutation = true
      const adversarialSave = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "case0-adversarial",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {
            [adversarialEntityId]: {
              position: [20, 0, 0],
              gameplay: {
                value: 99,
                throwAfterMutation: true,
              },
            },
          },
        },
      };

      const case0Result = await host.loadSave({ envelope: adversarialSave });
      assert.equal(case0Result.success, false, "Load with adversarial mutation-throw must fail");
      assert.ok(
        case0Result.error?.includes("Commit failed and was rolled back"),
        `Expected error to include 'Commit failed and was rolled back', got: ${case0Result.error}`,
      );

      // Post-failure structured query verification:
      snapshot = await probe.snapshot();
      adv = (snapshot.state.byName as Record<string, any>)?.AdversarialEntity;
      assert.equal(adv.position[0], 1, "Adversarial entity position.x must remain 1 after failed load");
      assert.equal(adv.gameplay?.state?.value, 5, "Adversarial entity script value must remain 5 after failed load");
      assert.equal(snapshot.running, true, "Runtime must remain running and healthy");

      // --- Case 1: Malformed gameplay state (e.g. moveCount = "INVALID") ---
      // Save requests: Hero position.x = 10 and corrupt gameplay state
      const malformedSave = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "case1-malformed",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {
            [heroEntityId]: {
              position: [10, 0, 0],
              gameplay: {
                moveCount: "INVALID",
                jumpCount: 0,
              },
            },
          },
        },
      };

      const case1Result = await host.loadSave({ envelope: malformedSave });
      assert.equal(case1Result.success, false, "Load with malformed gameplay state must fail");
      assert.ok(case1Result.error?.includes("moveCount must be a finite number"));

      // Assert ZERO partial mutation: Hero position is still 0, not 10!
      snapshot = await probe.snapshot();
      hero = (snapshot.state.byName as Record<string, any>)?.Hero;
      assert.equal(hero.position[0], 0, "Hero position must remain 0 (no partial transform apply)");
      assert.equal(hero.gameplay?.state?.moveCount, 0, "Hero moveCount must remain 0");
      assert.equal(snapshot.running, true, "Runtime must remain running");

      // --- Case 2A: Script restoration unsupported (entity without script) ---
      const noScriptSave = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "case2a-noscript",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {
            [cameraId]: {
              position: [0, 99, 5],
              gameplay: { someKey: 123 },
            },
          },
        },
      };

      const case2aResult = await host.loadSave({ envelope: noScriptSave });
      assert.equal(case2aResult.success, false, "Load with gameplay for scriptless entity must fail");
      assert.ok(case2aResult.error?.includes("has gameplay save state but no active script"));

      snapshot = await probe.snapshot();
      camera = (snapshot.state.byName as Record<string, any>)?.MainCamera;
      assert.equal(camera.position[1], 2, "Camera position must remain 2 (not 99)");

      // --- Case 2B: Script restoration unsupported (script does not implement restoreState) ---
      const unsupportedScriptSave = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "case2b-unsupported",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {
            [readOnlyNpcId]: {
              position: [50, 0, 0],
              gameplay: { score: 999 },
            },
          },
        },
      };

      const case2bResult = await host.loadSave({ envelope: unsupportedScriptSave });
      assert.equal(case2bResult.success, false, "Load with gameplay for unsupported script must fail");
      assert.ok(case2bResult.error?.includes("does not support state restoration"));

      snapshot = await probe.snapshot();
      npc = (snapshot.state.byName as Record<string, any>)?.ReadOnlyNpc;
      assert.equal(npc.position[0], 5, "ReadOnlyNpc position must remain 5 (not 50)");

      // --- Case 2C: Legacy-only script restoration rejected in atomic save.load ---
      const legacyScriptSave = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "case2c-legacy",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {
            [legacyNpcId]: {
              position: [70, 0, 0],
              gameplay: { legacyValue: 999 },
            },
          },
        },
      };

      const case2cResult = await host.loadSave({ envelope: legacyScriptSave });
      assert.equal(case2cResult.success, false, "Load with gameplay for legacy-only script must fail in atomic save.load");
      assert.ok(
        case2cResult.error?.includes("does not support transactional state restoration"),
        `Expected error to include 'does not support transactional state restoration', got: ${case2cResult.error}`,
      );

      // Assert zero mutation
      snapshot = await probe.snapshot();
      legacyNpc = (snapshot.state.byName as Record<string, any>)?.LegacyNpc;
      assert.equal(legacyNpc.position[0], 7, "LegacyNpc position must remain 7 (not 70)");
      assert.equal(legacyNpc.gameplay?.state?.legacyValue, 100, "LegacyNpc legacyValue must remain 100 (not 999)");
      assert.equal(snapshot.running, true, "Runtime must remain running");

      // --- Case 3: Restoration commit throws (with automatic rollback) ---
      // Save requests: Hero position.x = 10, ThrowingEntity position.x = 25 and throwing gameplay
      const throwingSave = {
        schemaVersion: 2,
        gameVersion: "0.1.0",
        slotId: "case3-throwing",
        savedAt: new Date().toISOString(),
        data: {
          sceneId,
          entities: {
            [heroEntityId]: {
              position: [10, 0, 0],
            },
            [throwingEntityId]: {
              position: [25, 0, 0],
              gameplay: { trigger: true },
            },
          },
        },
      };

      const case3Result = await host.loadSave({ envelope: throwingSave });
      assert.equal(case3Result.success, false, "Load where commit throws must fail");
      assert.ok(
        case3Result.error?.includes("Commit failed and was rolled back"),
        `Expected error to include 'Commit failed and was rolled back', got: ${case3Result.error}`,
      );

      // Assert rollback restored all transforms and state to exact pre-load state
      snapshot = await probe.snapshot();
      hero = (snapshot.state.byName as Record<string, any>)?.Hero;
      throwing = (snapshot.state.byName as Record<string, any>)?.ThrowingEntity;

      assert.equal(hero.position[0], 0, "Hero position must be rolled back to 0 (not left at 10)");
      assert.equal(throwing.position[0], -5, "ThrowingEntity position must be rolled back to -5 (not left at 25)");
      assert.equal(snapshot.running, true, "Runtime must remain running and healthy");

      // Verify structured logs contain the expected failure phases
      const logs = await probe.logs();
      const failLogs = logs.filter(l => l.message === "save.restoreFailed");
      assert.ok(failLogs.length >= 6, "Must log save.restoreFailed for each failure");
      assert.ok(failLogs.some(l => l.data?.phase === "preparation"), "Must log preparation phase failures");
      assert.ok(failLogs.some(l => l.data?.phase === "commit"), "Must log commit phase failure on throw");

      await host.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);
