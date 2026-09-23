import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ElectronRuntimeHost } from "../src/index.js";

const sceneId = stableId("scene", "save-list-electron");
const boxId = stableId("entity", "save-list-box");
const cameraId = stableId("entity", "save-list-camera");
const lightId = stableId("entity", "save-list-light");

function fixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "save-list-electron"),
    name: "Save List Electron Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Save List Scene",
        entities: [
          {
            id: boxId,
            name: "Box",
            components: {
              Primitive: {
                kind: "box",
                size: [1, 1, 1],
                color: "#44aa88",
              },
              Transform: { position: [0, 0, 0] },
            },
          },
          {
            id: cameraId,
            name: "Camera",
            components: {
              Camera: { type: "perspective", fov: 50, near: 0.1, far: 100 },
              Transform: { position: [0, 2, 5] },
            },
          },
          {
            id: lightId,
            name: "Light",
            components: {
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
              Transform: { position: [2, 4, 3] },
            },
          },
        ],
      },
    ],
  };
}

function displayAvailable(): boolean {
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return Boolean(process.env.DISPLAY);
  return false;
}

test(
  "real Electron save.list returns slots A and B and a missing load names them",
  { skip: !displayAvailable(), timeout: 60_000 },
  async () => {
    const saveDir = await mkdtemp(join(tmpdir(), "kinetra-save-list-"));
    const host = new ElectronRuntimeHost({
      saveDir,
      requestTimeoutMs: 30_000,
    });

    try {
      await host.start(fixtureProject(), sceneId, 1);
      const capturedA = await host.captureSave("A");
      const capturedB = await host.captureSave("B");
      assert.equal(capturedA.success, true);
      assert.equal(capturedB.success, true);

      const listed = await host.listSaves();
      assert.deepEqual(listed.slots, ["A", "B"]);

      const missing = await host.loadSave({ slotId: "missing-slot" });
      assert.equal(missing.success, false);
      assert.equal(missing.slotId, "missing-slot");
      assert.equal(typeof missing.error, "string");
      assert.match(missing.error ?? "", /missing-slot/);
      assert.match(missing.error ?? "", /Available slots: A, B/);
      assert.deepEqual(missing.availableSlots, ["A", "B"]);
      assert.equal(missing.error?.includes(saveDir), false);
      assert.equal(/[/\\]/.test(missing.error ?? ""), false);

      const query = await host.query();
      assert.equal(query.running, true);
      await host.stop();
    } finally {
      await host.close();
      await rm(saveDir, { recursive: true, force: true });
    }
  },
);
