import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ElectronRuntimeHost } from "../src/index.js";

const sceneId = stableId("scene", "log-metrics-electron");

function fixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "log-metrics-electron"),
    name: "Log Metrics Electron Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Log Metrics Scene",
        entities: [
          {
            id: stableId("entity", "log-metrics-box"),
            name: "Box",
            components: {
              Primitive: { kind: "box", size: [1, 1, 1], color: "#88aaff" },
              Transform: { position: [0, 0, 0] },
            },
          },
          {
            id: stableId("entity", "log-metrics-camera"),
            name: "Camera",
            components: {
              Camera: { type: "perspective", fov: 50, near: 0.1, far: 100 },
              Transform: { position: [0, 2, 5] },
            },
          },
          {
            id: stableId("entity", "log-metrics-light"),
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
  "real Electron reports logsDropped without changing the readLogs array",
  { skip: !displayAvailable(), timeout: 180_000 },
  async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "kinetra-log-metrics-"));
    const host = new ElectronRuntimeHost({
      userDataDir,
      requestTimeoutMs: 30_000,
    });

    try {
      await host.start(fixtureProject(), sceneId, 1);
      const before = await host.metrics();
      assert.deepEqual(before, { logsDropped: 0 });
      const initialLogs = await host.readLogs();
      assert.ok(Array.isArray(initialLogs));
      assert.ok(initialLogs.some((entry) => entry.message === "runtime.started"));

      await host.stop();
      const afterStop = await host.metrics();
      assert.equal(afterStop.logsDropped, 0);
      const stoppedLogs = await host.readLogs();
      assert.ok(Array.isArray(stoppedLogs));
      assert.ok(stoppedLogs.some((entry) => entry.message === "runtime.started"));
      assert.ok(stoppedLogs.some((entry) => entry.message === "runtime.stopped"));

      await host.start(fixtureProject(), sceneId, 2);
      assert.equal((await host.metrics()).logsDropped, 0);
      assert.ok(
        (await host.readLogs()).some((entry) => entry.message === "runtime.stopped"),
      );

      for (let index = 0; index < 2100; index += 1) {
        await host.injectInput({ action: "player.jump", phase: "press" });
      }
      const overflow = await host.metrics();
      assert.ok(overflow.logsDropped > 0);
      const retained = await host.readLogs();
      assert.ok(Array.isArray(retained));
      assert.ok(retained.length <= 2000);
      assert.equal("dropped" in retained, false);
      await host.stop();
    } finally {
      await host.close();
      await rm(userDataDir, { recursive: true, force: true });
    }

    const leaked = await processesUsing(userDataDir);
    assert.deepEqual(leaked, []);

    const freshDir = await mkdtemp(join(tmpdir(), "kinetra-log-metrics-fresh-"));
    const fresh = new ElectronRuntimeHost({
      userDataDir: freshDir,
      requestTimeoutMs: 30_000,
    });
    try {
      await fresh.start(fixtureProject(), sceneId, 1);
      assert.deepEqual(await fresh.metrics(), { logsDropped: 0 });
      assert.ok(Array.isArray(await fresh.readLogs()));
      await fresh.stop();
    } finally {
      await fresh.close();
      await rm(freshDir, { recursive: true, force: true });
    }
  },
);
