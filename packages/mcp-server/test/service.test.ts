import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  serializeProject,
  stableId,
  type ProjectDocument,
} from "@kinetra/project-model";

import { FileProjectStore, KinetraAgentService } from "../src/index.js";

const sceneId = stableId("scene", "mcp-main");
const playerId = stableId("entity", "mcp-player");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "mcp-fixture"),
    name: "MCP fixture",
    scenes: [
      {
        id: sceneId,
        name: "Main",
        entities: [],
      },
    ],
  };
}

test("agent service persists authoring commands and can verify a runtime fix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinetra-mcp-"));
  const projectPath = join(directory, "game.kinetra.json");
  const store = new FileProjectStore(projectPath);

  await store.save(fixture());

  const service = await KinetraAgentService.fromFile(projectPath);

  const created = await service.createEntity({
    sceneId,
    id: playerId,
    name: "Player",
    expectedProjectRevision: 0,
    components: {
      Transform: {
        position: [99, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
  });

  assert.equal(created.revision, 1);
  assert.ok(created.undoToken);

  await service.startRuntime(sceneId);

  const broken = await service.queryRuntime({ entityIds: [playerId] });
  assert.deepEqual(broken.entities[0]?.position, [99, 0, 0]);

  await service.stopRuntime();

  const patched = await service.patchComponent({
    entityId: playerId,
    component: "Transform",
    expectedProjectRevision: 1,
    patch: { position: [2, 0, 0] },
  });

  assert.equal(patched.revision, 2);

  await service.startRuntime(sceneId);

  const fixed = await service.queryRuntime({ entityIds: [playerId] });
  assert.deepEqual(fixed.entities[0]?.position, [2, 0, 0]);
  assert.equal(fixed.projectRevision, 2);

  await service.injectRuntimeInput({
    action: "player.jump",
    phase: "press",
  });

  const logs = await service.readRuntimeLogs();
  assert.ok(logs.some((entry) => entry.message === "runtime.input"));

  const frame = await service.captureRuntimeFrame();
  assert.equal(frame.available, false);
  assert.equal(frame.fallbackState?.running, true);

  const persistedText = await readFile(projectPath, "utf8");
  const persisted = JSON.parse(persistedText) as ProjectDocument;
  assert.deepEqual(
    persisted.scenes[0]?.entities[0]?.components.Transform,
    {
      position: [2, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  );
});

test("dry-run does not persist or advance project revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinetra-mcp-dry-"));
  const projectPath = join(directory, "game.kinetra.json");
  const store = new FileProjectStore(projectPath);

  await store.save(fixture());

  const before = await readFile(projectPath, "utf8");
  const service = await KinetraAgentService.fromFile(projectPath);

  const result = await service.createScene({
    name: "Dry run",
    dryRun: true,
    expectedProjectRevision: 0,
  });

  assert.equal(result.revision, 0);
  assert.equal(result.proposedRevision, 1);
  assert.equal(service.inspectProject().scenes.length, 1);
  assert.equal(await readFile(projectPath, "utf8"), before);
});

test("file store writes deterministic serialized project data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinetra-store-"));
  const projectPath = join(directory, "game.kinetra.json");
  const store = new FileProjectStore(projectPath);
  const project = fixture();

  await store.save(project);

  assert.equal(await readFile(projectPath, "utf8"), serializeProject(project));
  assert.deepEqual(await store.load(), project);
});
