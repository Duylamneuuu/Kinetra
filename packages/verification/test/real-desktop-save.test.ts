import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p6-desktop-save-scene");
const heroEntityId = stableId("entity", "p6-hero-desktop-save");
const cameraId = stableId("entity", "p6-camera-desktop-save");
const lightId = stableId("entity", "p6-light-desktop-save");

function desktopSaveFixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p6-real-desktop-save"),
    name: "P6 Real Desktop Save Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Desktop Save Acceptance Scene",
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

function createDesktopHost(saveDir: string): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    saveDir,
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
    if (
      /^[A-Za-z]:[\\/]/.test(obj) ||
      obj.startsWith("/home/") ||
      obj.startsWith("/Users/")
    ) {
      throw new Error(
        `Forbidden absolute machine path found in save data at ${path}: ${obj}`,
      );
    }
  }
  if (typeof obj === "object") {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype && !Array.isArray(obj)) {
      throw new Error(
        `Forbidden class instance found in save data at ${path}: ${proto?.constructor?.name}`,
      );
    }
    for (const [k, v] of Object.entries(obj)) {
      assertNoForbiddenObjects(v, `${path}.${k}`);
    }
  }
}

test(
  "file-backed desktop save persistence: real Process A saves to disk -> terminates -> fresh Process B loads from disk -> verifies gameplay -> captures frame",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const tempSaveDir = await mkdtemp(
      join(tmpdir(), "kinetra-desktop-save-suite-"),
    );

    try {
      // -------------------------------------------------------------
      // PROCESS A: Run session, modify gameplay, save to desktop disk
      // -------------------------------------------------------------
      const hostA = createDesktopHost(tempSaveDir);
      const probeA = new KinetraRuntimeProbe({
        host: hostA,
        project: () => desktopSaveFixtureProject(),
        initialRevision: 1,
        closeOnStop: false,
      });

      try {
        const manifestA: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p6-desktop-save-capture",
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
            // Character moves right
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
            // Character jumps
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
            // Capture save to persistent slot
            { type: "save.capture", slotId: "desktop-slot-alpha" },
            { type: "runtime.stop" },
          ],
        };

        const runnerA = new AcceptanceRunner(probeA);
        const reportA = await runnerA.run(manifestA);
        assert.equal(
          reportA.passed,
          true,
          `Process A manifest failed: ${JSON.stringify(reportA.steps.filter((s) => !s.passed))}`,
        );
      } finally {
        // Complete termination of Process A
        await probeA.close();
        await hostA.close();
      }

      // Assert on-disk save document in isolated directory
      const onDiskFile = join(tempSaveDir, "desktop-slot-alpha.json");
      assert.ok(
        existsSync(onDiskFile),
        `Expected save file on disk at "${onDiskFile}"`,
      );

      const fileContent = JSON.parse(await readFile(onDiskFile, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(fileContent.schemaVersion, 2);
      assert.equal(fileContent.slotId, "desktop-slot-alpha");
      assert.ok(typeof fileContent.savedAt === "string");

      const data = fileContent.data as Record<string, unknown>;
      assert.equal(data.sceneId, sceneId);

      const entities = data.entities as Record<string, Record<string, unknown>>;
      assert.ok(entities[heroEntityId]);
      const heroData = entities[heroEntityId];
      const pos = heroData.position as [number, number, number];
      assert.ok(Math.abs(pos[0] - 1.0) < 0.05);
      assert.deepEqual(heroData.gameplay, {
        moveCount: 1,
        jumpCount: 1,
        lastAction: "player.jump",
      });

      // Assert no machine paths or function references in on-disk document
      assertNoForbiddenObjects(fileContent);

      // Verify no temporary files remain in save directory
      const filesInDir = await readdir(tempSaveDir);
      assert.deepEqual(filesInDir, ["desktop-slot-alpha.json"]);

      // -------------------------------------------------------------
      // PROCESS B: Brand new Electron process, fresh state -> load from disk
      // -------------------------------------------------------------
      const hostB = createDesktopHost(tempSaveDir);
      const probeB = new KinetraRuntimeProbe({
        host: hostB,
        project: () => desktopSaveFixtureProject(),
        initialRevision: 1,
        closeOnStop: false,
      });

      try {
        const manifestB: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "p6-desktop-save-restore",
          seed: 42,
          target: "runtime",
          steps: [
            // Fresh startup from clean project definition
            { type: "runtime.start", sceneId },
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

            // Restore from persistent desktop file
            { type: "save.load", slotId: "desktop-slot-alpha" },

            // Assert restored gameplay matches Process A's saved state
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

            // Continue gameplay simulation in Process B
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

            // Real PNG capture after restore
            { type: "assert.screenshotValidPng", minBytes: 1000 },
            { type: "assert.logAbsent", minimumLevel: "error" },
            { type: "runtime.stop" },
          ],
        };

        const runnerB = new AcceptanceRunner(probeB);
        const reportB = await runnerB.run(manifestB);
        assert.equal(
          reportB.passed,
          true,
          `Process B manifest failed: ${JSON.stringify(reportB.steps.filter((s) => !s.passed))}`,
        );

        // Verify frame bytes directly from Process B
        const frameBytes = await probeB.captureFrame();
        assert.ok(
          frameBytes.length > 1000,
          `Expected frame > 1000 bytes, got ${frameBytes.length}`,
        );
        const pngHeader = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        assert.equal(
          Buffer.from(frameBytes.subarray(0, 8)).compare(pngHeader),
          0,
          "Frame must have valid PNG header",
        );
      } finally {
        await probeB.close();
        await hostB.close();
      }
    } finally {
      await rm(tempSaveDir, { recursive: true, force: true });
    }
  },
);

test(
  "file-backed save migration: synthetic v1 on-disk save document migrates to v2 and restores in fresh Electron session",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const tempSaveDir = await mkdtemp(
      join(tmpdir(), "kinetra-desktop-migration-"),
    );

    try {
      // Write synthetic v1 save file directly to disk in test save root
      const v1SaveOnDisk = {
        schemaVersion: 1,
        gameVersion: "0.0.1",
        slotId: "legacy-v1-disk",
        savedAt: "2026-09-19T12:00:00.000Z",
        data: {
          sceneId,
          entities: {
            [heroEntityId]: {
              position: [4.5, 0, 0],
              state: {
                moveCount: 9,
                jumpCount: 3,
                lastAction: "player.moveRight",
              },
            },
          },
        },
      };

      await writeFile(
        join(tempSaveDir, "legacy-v1-disk.json"),
        JSON.stringify(v1SaveOnDisk),
        "utf8",
      );

      const host = createDesktopHost(tempSaveDir);
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => desktopSaveFixtureProject(),
        initialRevision: 1,
        closeOnStop: false,
      });

      try {
        await probe.start(sceneId, 1);

        const loadResult = await host.loadSave({ slotId: "legacy-v1-disk" });
        assert.equal(loadResult.success, true);
        assert.equal(
          loadResult.schemaVersion,
          2,
          "Migrator must advance schemaVersion to 2",
        );

        const snapshot = await probe.snapshot();
        const hero = (snapshot.state.byName as Record<string, any>)?.Hero;
        assert.ok(hero);
        assert.ok(Math.abs(hero.position[0] - 4.5) < 0.05);
        assert.equal(hero.gameplay?.state?.moveCount, 9);
        assert.equal(hero.gameplay?.state?.jumpCount, 3);

        await host.stop();
      } finally {
        await probe.close();
        await host.close();
      }
    } finally {
      await rm(tempSaveDir, { recursive: true, force: true });
    }
  },
);

test(
  "file-backed corrupt save, missing slot, and path traversal rejection return structured failure without crashing Electron",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const tempSaveDir = await mkdtemp(
      join(tmpdir(), "kinetra-desktop-corrupt-"),
    );

    try {
      // 1. Create a corrupt / truncated JSON file on disk
      await writeFile(
        join(tempSaveDir, "corrupt-slot.json"),
        '{"schemaVersion": 2, "slotId": "corrupt-slot", "data": { broken JSON',
        "utf8",
      );

      const host = createDesktopHost(tempSaveDir);
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => desktopSaveFixtureProject(),
        initialRevision: 1,
        closeOnStop: false,
      });

      try {
        await probe.start(sceneId, 1);

        // Case A: Load corrupt save file
        const corruptResult = await host.loadSave({ slotId: "corrupt-slot" });
        assert.equal(corruptResult.success, false);
        assert.equal(corruptResult.phase, "validation");
        assert.ok(
          corruptResult.error?.includes("Failed to read save document"),
          `Expected read error, got: ${corruptResult.error}`,
        );

        // Verify runtime is alive
        let snapshot = await probe.snapshot();
        assert.equal(snapshot.running, true);

        // Case B: Load missing slot
        const missingResult = await host.loadSave({ slotId: "non-existent-slot" });
        assert.equal(missingResult.success, false);
        assert.equal(missingResult.phase, "validation");
        assert.ok(
          missingResult.error?.includes("Save document not found"),
          `Expected not found error, got: ${missingResult.error}`,
        );

        // Verify runtime is still alive
        snapshot = await probe.snapshot();
        assert.equal(snapshot.running, true);

        // Case C: Path traversal injection via slotId
        const traversalResult = await host.loadSave({
          slotId: "../../traversal-escape",
        });
        assert.equal(traversalResult.success, false);
        assert.equal(traversalResult.phase, "validation");
        assert.ok(
          traversalResult.error?.includes("Failed to read save document") ||
            traversalResult.error?.includes("Invalid storage key"),
          `Expected traversal rejection, got: ${traversalResult.error}`,
        );

        // Verify runtime is still alive
        snapshot = await probe.snapshot();
        assert.equal(snapshot.running, true);

        await host.stop();
      } finally {
        await probe.close();
        await host.close();
      }
    } finally {
      await rm(tempSaveDir, { recursive: true, force: true });
    }
  },
);
