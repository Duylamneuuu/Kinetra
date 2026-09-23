import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ElectronRuntimeHost } from "../src/index.js";

const sceneId = stableId("scene", "missing-scene-electron");
const otherSceneId = stableId("scene", "missing-scene-other");

function fixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "missing-scene-electron"),
    name: "Missing Scene Electron Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Primary",
        entities: [
          {
            id: stableId("entity", "missing-scene-box"),
            name: "Box",
            components: {
              Primitive: { kind: "box", size: [1, 1, 1], color: "#ffcc66" },
              Transform: { position: [0, 0, 0] },
            },
          },
          {
            id: stableId("entity", "missing-scene-camera"),
            name: "Camera",
            components: {
              Camera: { type: "perspective", fov: 50, near: 0.1, far: 100 },
              Transform: { position: [0, 2, 5] },
            },
          },
          {
            id: stableId("entity", "missing-scene-light"),
            name: "Light",
            components: {
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
              Transform: { position: [2, 4, 3] },
            },
          },
        ],
      },
      {
        id: otherSceneId,
        name: "Secondary",
        entities: [],
      },
    ],
  };
}

function displayAvailable(): boolean {
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return Boolean(process.env.DISPLAY);
  return false;
}

async function processesUsing(token: string): Promise<number[]> {
  const hits: number[] = [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return hits;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      const cmdline = await readFile(`/proc/${name}/cmdline`);
      if (cmdline.toString("utf8").includes(token)) hits.push(pid);
    } catch {
      // Process exited while scanning.
    }
  }
  return hits;
}

test(
  "real Electron runtime.start names available scenes and can start afterwards",
  { skip: !displayAvailable(), timeout: 60_000 },
  async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "kinetra-missing-scene-"));
    const host = new ElectronRuntimeHost({
      userDataDir,
      requestTimeoutMs: 30_000,
    });

    try {
      await assert.rejects(
        () => host.start(fixtureProject(), "scene-does-not-exist", 1),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /scene-does-not-exist/);
          assert.match(error.message, /Available scenes:/);
          assert.match(error.message, new RegExp(sceneId));
          assert.match(error.message, new RegExp(otherSceneId));
          return true;
        },
      );

      const idle = await host.query();
      assert.equal(idle.running, false);

      await host.start(fixtureProject(), sceneId, 2);
      const running = await host.query();
      assert.equal(running.running, true);
      assert.equal(running.sceneId, sceneId);
      await host.stop();
      const stopped = await host.query();
      assert.equal(stopped.running, false);
    } finally {
      await host.close();
      await rm(userDataDir, { recursive: true, force: true });
    }

    const leaked = await processesUsing(userDataDir);
    assert.deepEqual(leaked, []);
  },
);
