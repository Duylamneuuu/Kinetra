import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectDocument } from "@kinetra/project-model";

import {
  formatToolError,
  KinetraAgentService,
  ProjectPersistError,
  type ProjectStore,
} from "../src/index.js";

function emptyProject(): ProjectDocument {
  return { schemaVersion: 1, projectId: "project-persist-revision", name: "Persist", scenes: [] };
}

class FlakyStore implements ProjectStore {
  failNext = 0;
  saved: ProjectDocument[] = [];

  async load(): Promise<ProjectDocument> {
    return emptyProject();
  }

  async save(project: ProjectDocument): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("disk full");
    }
    this.saved.push(structuredClone(project));
  }
}

function persistError(error: unknown): ProjectPersistError {
  assert.ok(error instanceof ProjectPersistError, `expected ProjectPersistError, got ${String(error)}`);
  return error;
}

test("a rolled-back save failure reports the revision an optimistic retry must use (#187)", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });
  const before = service.bus.revision;

  store.failNext = 1;
  let caught: unknown;
  try {
    await service.createScene({ name: "Main", id: "scene-main", expectedProjectRevision: before });
  } catch (error) {
    caught = error;
  }
  const error = persistError(caught);
  assert.equal(error.code, "PERSIST_FAILED");
  assert.equal(error.rolledBack, true);
  assert.match(error.message, /disk full/);
  assert.equal(error.projectRevision, service.bus.revision);
  // Revisions are monotonic: the command and its rollback each advanced it even though the
  // project content is back to what it was.
  assert.equal(error.projectRevision, before + 2);
  assert.deepEqual(service.inspectProject().scenes, []);
  assert.ok(error.cause instanceof Error && error.cause.message === "disk full");

  // Retrying with the stale revision is a clean STALE_REVISION, not a mystery...
  await assert.rejects(
    () => service.createScene({ name: "Main", id: "scene-main", expectedProjectRevision: before }),
    (stale: unknown) => (stale as { code?: string }).code === "STALE_REVISION",
  );
  // ...and retrying with the revision the error reported succeeds.
  const retry = await service.createScene({
    name: "Main",
    id: "scene-main",
    expectedProjectRevision: error.projectRevision,
  });
  assert.equal(retry.ok, true);
  assert.equal(store.saved.at(-1)?.scenes[0]?.id, "scene-main");
});

test("the MCP tool error for a failed save is structured with code, revision and remediation", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });
  store.failNext = 1;
  const error = await service.createScene({ name: "Main", id: "scene-main" }).then(
    () => assert.fail("save should fail"),
    (thrown: unknown) => thrown,
  );
  const formatted = JSON.parse(formatToolError(error)) as Record<string, unknown>;
  assert.equal(formatted.code, "PERSIST_FAILED");
  assert.match(String(formatted.message), /disk full/);
  assert.match(String(formatted.remediation), new RegExp(`expectedProjectRevision.*${service.bus.revision}`));
});

test("a failed undo save is not rolled back and says so, with the current revision", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });
  const created = await service.createScene({ name: "Main", id: "scene-main" });

  store.failNext = 1;
  let caught: unknown;
  try {
    await service.undo(created.undoToken as string);
  } catch (error) {
    caught = error;
  }
  const error = persistError(caught);
  assert.equal(error.rolledBack, false);
  assert.equal(error.projectRevision, service.bus.revision);
  assert.deepEqual(service.inspectProject().scenes, [], "the undo stays applied in memory");
});

test("a save failure after a later command already landed is reported as not rolled back", async () => {
  // Gate the first save so a second command lands while it is in flight; the first save then
  // fails and cannot be undone (undo is last-in-first-out).
  let releaseFirst!: (error?: Error) => void;
  let calls = 0;
  const saved: ProjectDocument[] = [];
  const store: ProjectStore = {
    load: async () => emptyProject(),
    save: (project) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve, reject) => {
          releaseFirst = (error) => (error ? reject(error) : resolve());
        });
      }
      saved.push(structuredClone(project));
      return Promise.resolve();
    },
  };
  const service = new KinetraAgentService(emptyProject(), { store });
  const first = service.createScene({ name: "A", id: "scene-a" });
  const second = service.createScene({ name: "B", id: "scene-b" });
  await second;
  releaseFirst(new Error("disk full"));
  const error = persistError(await first.then(() => undefined, (thrown: unknown) => thrown));
  assert.equal(error.rolledBack, false);
  assert.equal(error.projectRevision, service.bus.revision);
  assert.deepEqual(
    service.inspectProject().scenes.map((scene) => scene.id).sort(),
    ["scene-a", "scene-b"],
  );
  assert.deepEqual(saved.at(-1)?.scenes.map((scene) => scene.id).sort(), ["scene-a", "scene-b"]);
});
