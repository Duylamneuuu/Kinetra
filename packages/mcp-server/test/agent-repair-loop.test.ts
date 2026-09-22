import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import type { AcceptanceManifest, AcceptanceReport } from "@kinetra/verification";

import { FileProjectStore, KinetraAgentService } from "../src/index.js";

const sceneId = stableId("scene", "agent-repair");
const markerId = stableId("entity", "agent-repair-marker");
const cameraId = stableId("entity", "agent-repair-camera");
const lightId = stableId("entity", "agent-repair-light");

function emptyProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "agent-repair"),
    name: "Agent repair loop",
    scenes: [
      {
        id: sceneId,
        name: "Repair",
        entities: [],
      },
    ],
  };
}

function hostInfo(report: AcceptanceReport): Record<string, unknown> {
  const info = report.observations?.hostInfo;
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    throw new Error(`acceptance report is missing hostInfo: ${report.failureReason ?? ""}`);
  }
  return info as Record<string, unknown>;
}

function hostPlatform(report: AcceptanceReport): unknown {
  return hostInfo(report).platform;
}

function hostPackaged(report: AcceptanceReport): unknown {
  return hostInfo(report).isPackaged;
}

function positionManifest(expectedX: number, suite: string): AcceptanceManifest {
  return {
    schemaVersion: 1,
    suite,
    seed: 7,
    target: "runtime",
    steps: [
      { type: "runtime.start", sceneId },
      {
        type: "assert.equal",
        path: "state.byName.Marker.position.0",
        expected: expectedX,
      },
      { type: "assert.screenshotValidPng", minBytes: 1_000 },
      { type: "assert.logAbsent", minimumLevel: "error" },
      { type: "runtime.stop" },
    ],
  };
}

// Same gate as `canRunRealElectronTests` on PR #49 (`cursor/linux-real-tests-a83f`).
// That export is not on main, so this branch stays independent. After #49 lands,
// replace this condition with `!canRunRealElectronTests()` from `@kinetra/verification`.
const realElectron =
  process.platform === "win32" ||
  (process.platform === "linux" && Boolean(process.env.DISPLAY));

test(
  "agent authors a broken marker, observes the real Electron failure, repairs it, and passes",
  { skip: !realElectron, timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "kinetra-agent-repair-"));
    try {
      const projectPath = join(directory, "game.kinetra.json");
      const store = new FileProjectStore(projectPath);
      await store.save(emptyProject());

      const service = await KinetraAgentService.fromFile(projectPath);

      const marker = await service.createEntity({
        sceneId,
        id: markerId,
        name: "Marker",
        expectedProjectRevision: 0,
        components: {
          Primitive: {
            kind: "box",
            size: [1.4, 1.4, 1.4],
            color: "#ff8844",
          },
          Transform: {
            position: [99, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      });
      assert.equal(marker.revision, 1);

      const camera = await service.createEntity({
        sceneId,
        id: cameraId,
        name: "Camera",
        expectedProjectRevision: marker.revision,
        components: {
          Camera: { type: "perspective", fov: 55, near: 0.1, far: 100 },
          Transform: { position: [0, 0, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      });
      const light = await service.createEntity({
        sceneId,
        id: lightId,
        name: "Key",
        expectedProjectRevision: camera.revision,
        components: {
          Light: { kind: "directional", color: "#ffffff", intensity: 3 },
          Transform: { position: [3, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      });

      const broken = await service.runAcceptance({
        manifest: positionManifest(0, "agent-repair-broken"),
      });

      assert.equal(broken.passed, false);
      assert.match(broken.failureReason ?? "", /99/);
      assert.equal(hostPlatform(broken), process.platform);
      assert.equal(hostPackaged(broken), false);

      const repaired = await service.patchComponent({
        entityId: markerId,
        component: "Transform",
        expectedProjectRevision: light.revision,
        patch: { position: [0, 0, 0] },
      });
      assert.ok(repaired.revision > light.revision);

      const fixed = await service.runAcceptance({
        manifest: positionManifest(0, "agent-repair-fixed"),
      });

      assert.equal(fixed.passed, true, fixed.failureReason);
      assert.equal(hostPlatform(fixed), process.platform);
      assert.equal(hostPackaged(fixed), false);

      const persisted = JSON.parse(await readFile(projectPath, "utf8")) as ProjectDocument;
      const persistedMarker = persisted.scenes[0]?.entities.find(
        (entity) => entity.id === markerId,
      );
      assert.deepEqual(persistedMarker?.components.Transform, {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
