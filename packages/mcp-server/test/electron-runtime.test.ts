import assert from "node:assert/strict";
import test from "node:test";

import {
  stableId,
  type ProjectDocument,
} from "@kinetra/project-model";

import { ElectronRuntimeHost } from "../src/index.js";

const sceneId = stableId("scene", "electron-capture");
const boxId = stableId("entity", "electron-box");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "electron-capture"),
    name: "Electron capture fixture",
    scenes: [
      {
        id: sceneId,
        name: "Capture",
        entities: [
          {
            id: boxId,
            name: "Orange Box",
            components: {
              Primitive: {
                kind: "box",
                size: [1.6, 1.6, 1.6],
                color: "#ff8844",
                roughness: 0.45,
              },
              Transform: {
                position: [0, 0, 0],
              },
            },
          },
          {
            id: stableId("entity", "electron-camera"),
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
            id: stableId("entity", "electron-key"),
            name: "Key",
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
          {
            id: stableId("entity", "electron-ambient"),
            name: "Ambient",
            components: {
              Light: {
                kind: "ambient",
                color: "#8aa6d8",
                intensity: 1,
              },
            },
          },
        ],
      },
    ],
  };
}

test(
  "Electron runtime renders project state and returns a real PNG frame",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = new ElectronRuntimeHost({
      requestTimeoutMs: 30_000,
      ...(process.env.KINETRA_RUNTIME_EXECUTABLE
        ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
        : {}),
    });

    try {
      await host.start(project(), sceneId, 7);

      const state = await host.query({
        entityIds: [boxId],
      });

      assert.equal(state.running, true);
      assert.equal(state.projectRevision, 7);
      assert.deepEqual(
        state.entities[0]?.position,
        [0, 0, 0],
      );

      const frame = await host.captureFrame();

      assert.equal(frame.available, true);
      assert.equal(frame.mimeType, "image/png");
      assert.ok(frame.base64);

      const bytes = Buffer.from(frame.base64, "base64");
      assert.ok(bytes.length > 1_000);
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );

      await host.injectInput({
        action: "player.jump",
        phase: "press",
      });

      const logs = await host.readLogs();
      assert.ok(
        logs.some(
          (entry) => entry.message === "runtime.input",
        ),
      );
    } finally {
      await host.close();
    }
  },
);
