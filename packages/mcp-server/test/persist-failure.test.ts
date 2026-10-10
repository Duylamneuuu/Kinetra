import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectDocument } from "@kinetra/project-model";

import { KinetraAgentService, type ProjectStore } from "../src/index.js";

function emptyProject(): ProjectDocument {
  return { schemaVersion: 1, projectId: "project-persist-failure", name: "Persist", scenes: [] };
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

test("a failed save rolls the in-memory project back so the same command can be retried", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });

  store.failNext = 1;
  await assert.rejects(() => service.createScene({ name: "Main", id: "scene-main" }), /disk full/);

  assert.deepEqual(
    service.inspectProject().scenes,
    [],
    "memory must match what is on disk after the save failed",
  );

  // The retry must succeed instead of failing with SCENE_ALREADY_EXISTS.
  const retry = await service.createScene({ name: "Main", id: "scene-main" });
  assert.equal(retry.ok, true);
  assert.deepEqual(service.inspectProject().scenes.map((scene) => scene.id), ["scene-main"]);
  assert.equal(store.saved.at(-1)?.scenes[0]?.id, "scene-main");
});

test("a failed save of a dry run or a later successful save is unaffected", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });

  const dry = await service.createScene({ name: "Dry", id: "scene-dry", dryRun: true });
  assert.equal(dry.undoToken, undefined);
  assert.equal(store.saved.length, 0);

  await service.createScene({ name: "A", id: "scene-a" });
  store.failNext = 1;
  await assert.rejects(() => service.createScene({ name: "B", id: "scene-b" }), /disk full/);

  assert.deepEqual(service.inspectProject().scenes.map((scene) => scene.id), ["scene-a"]);
  await service.createScene({ name: "B", id: "scene-b" });
  assert.deepEqual(
    store.saved.at(-1)?.scenes.map((scene) => scene.id).sort(),
    ["scene-a", "scene-b"],
  );
});

test("a failed save after undo() can be retried: the spent token still flushes memory to disk", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });

  const created = await service.createScene({ name: "Main", id: "scene-main" });
  assert.ok(created.undoToken);
  assert.equal(store.saved.at(-1)?.scenes.length, 1);

  store.failNext = 1;
  await assert.rejects(() => service.undo(created.undoToken as string), /disk full/);
  // The undo itself was applied and its token is spent, so it cannot be redone.
  assert.deepEqual(service.inspectProject().scenes, []);
  assert.equal(store.saved.at(-1)?.scenes.length, 1, "disk still holds the scene until a save succeeds");

  // Retrying the spent token is refused by the bus, but disk must catch up with memory.
  await assert.rejects(() => service.undo(created.undoToken as string));
  assert.equal(store.saved.at(-1)?.scenes.length, 0, "the retry flushed the undone project");
  const writes = store.saved.length;

  // Nothing is pending any more: a refused undo must not write again.
  await assert.rejects(() => service.undo(created.undoToken as string));
  assert.equal(store.saved.length, writes);
});

test("a command whose own save fails is rolled back but keeps an earlier failed undo save pending", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });

  const created = await service.createScene({ name: "Main", id: "scene-main" });
  store.failNext = 1;
  await assert.rejects(() => service.undo(created.undoToken as string), /disk full/);

  store.failNext = 1;
  await assert.rejects(() => service.createScene({ name: "B", id: "scene-b" }), /disk full/);
  assert.deepEqual(service.inspectProject().scenes, []);
  assert.equal(store.saved.length, 1);

  // The pending save from the undo is still owed: a refused undo flushes it.
  await assert.rejects(() => service.undo(created.undoToken as string));
  assert.equal(store.saved.length, 2);
  assert.equal(store.saved.at(-1)?.scenes.length, 0);
});

test("a successful undo() save writes once and leaves nothing pending", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });

  const created = await service.createScene({ name: "Main", id: "scene-main" });
  await service.undo(created.undoToken as string);
  assert.equal(store.saved.length, 2);
  await assert.rejects(() => service.undo(created.undoToken as string));
  assert.equal(store.saved.length, 2);
});
