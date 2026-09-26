import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AcceptanceManifest } from "@kinetra/verification";

import { KinetraAgentService } from "../src/index.js";

function arenaFixturePath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, "examples/reference-game/arena.kinetra.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("examples/reference-game/arena.kinetra.json was not found");
}

const fixturePath = arenaFixturePath();

const realElectron =
  process.platform === "win32" ||
  (process.platform === "linux" && Boolean(process.env.DISPLAY));

test(
  "arena file workflow loads a temp copy, patches through the command bus, and proves it in Electron",
  { skip: !realElectron, timeout: 90_000 },
  async () => {
    const fixtureBefore = await readFile(fixturePath);
    const fixtureHash = createHash("sha256").update(fixtureBefore).digest("hex");
    const directory = await mkdtemp(join(tmpdir(), "kinetra-arena-file-"));
    const projectPath = join(directory, "arena.kinetra.json");

    try {
      await copyFile(fixturePath, projectPath);
      assert.notEqual(projectPath, fixturePath);

      const service = await KinetraAgentService.fromFile(projectPath);
      const inspected = service.inspectProject();
      assert.equal(inspected.name, "Kinetra Arena");
      assert.equal(inspected.schemaVersion, 1);
      const scene = inspected.scenes.find((item) => item.entityCount > 0);
      assert.ok(scene);
      assert.ok(scene.entityCount > 1);

      const players = service.queryEntities({
        sceneId: scene.id,
        nameContains: "Player",
        limit: 12,
      });
      assert.equal(players.total, 1);
      const player = players.items[0]?.entity;
      assert.equal(player?.name, "Player");
      assert.equal(typeof player?.id, "string");

      const cores = service.queryEntities({
        sceneId: scene.id,
        nameContains: "PowerCore",
        selectComponents: ["Transform"],
        limit: 12,
      });
      assert.equal(cores.total, 1);
      const core = cores.items[0]?.entity;
      assert.ok(core);
      const transform = core.components.Transform;
      assert.ok(transform && typeof transform === "object" && !Array.isArray(transform));
      assert.deepEqual(transform.position, [5, 0.5, 2]);

      const patched = await service.patchComponent({
        entityId: core.id,
        component: "Transform",
        expectedProjectRevision: inspected.revision,
        patch: { position: [4, 0.5, 2] },
      });
      assert.equal(typeof patched.undoToken, "string");
      assert.ok(patched.undoToken);

      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "arena-file-workflow",
        seed: 7,
        target: "runtime",
        steps: [
          { type: "runtime.start", sceneId: scene.id },
          { type: "assert.equal", path: "state.byName.Player.position.0", expected: -5 },
          { type: "assert.equal", path: "state.byName.PowerCore.position.0", expected: 4 },
          { type: "assert.screenshotValidPng", minBytes: 1_000 },
          { type: "runtime.stop" },
        ],
      };
      const report = await service.runAcceptance({ manifest });
      assert.equal(report.passed, true, report.failureReason);
      assert.equal(report.observations?.hostInfo && (report.observations.hostInfo as { isPackaged?: boolean }).isPackaged, false);

      const undone = await service.undo(patched.undoToken, patched.revision);
      assert.equal(undone.ok, true);
      const restored = service.queryEntities({
        sceneId: scene.id,
        nameContains: "PowerCore",
        selectComponents: ["Transform"],
        limit: 12,
      });
      const restoredTransform = restored.items[0]?.entity.components.Transform;
      assert.ok(restoredTransform && typeof restoredTransform === "object");
      assert.deepEqual(
        (restoredTransform as { position?: unknown }).position,
        [5, 0.5, 2],
      );

      const persisted = await readFile(projectPath);
      assert.equal(persisted.equals(fixtureBefore), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
      const fixtureAfter = await readFile(fixturePath);
      assert.equal(
        createHash("sha256").update(fixtureAfter).digest("hex"),
        fixtureHash,
      );
    }
  },
);
