import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectDocument } from "@kinetra/project-model";

import { KinetraAgentService, type ProjectStore } from "../src/index.js";

function emptyProject(): ProjectDocument {
  return { schemaVersion: 1, projectId: "project-flush-failure", name: "Flush", scenes: [] };
}

class FlakyStore implements ProjectStore {
  failNext = 0;
  attempts = 0;
  saved: ProjectDocument[] = [];

  async load(): Promise<ProjectDocument> {
    return emptyProject();
  }

  async save(project: ProjectDocument): Promise<void> {
    this.attempts += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("disk full");
    }
    this.saved.push(structuredClone(project));
  }
}

test("a refused undo retry whose flush also fails reports the bus error, not the disk error, and stays pending", async () => {
  const store = new FlakyStore();
  const service = new KinetraAgentService(emptyProject(), { store });

  const created = await service.createScene({ name: "Main", id: "scene-main" });
  const token = created.undoToken as string;
  assert.ok(token);

  // The undo applies in memory but its save fails: disk is now behind memory.
  store.failNext = 1;
  await assert.rejects(() => service.undo(token), /disk full/);
  assert.deepEqual(service.inspectProject().scenes, []);
  assert.equal(store.saved.at(-1)?.scenes.length, 1);

  // The retry is refused by the bus (spent token). Its best-effort flush fails as well, and that
  // failure is swallowed: the caller sees the refusal, never the secondary disk error.
  store.failNext = 1;
  const attemptsBefore = store.attempts;
  await assert.rejects(
    () => service.undo(token),
    (error: unknown) => error instanceof Error && !/disk full/.test(error.message),
  );
  assert.equal(store.attempts, attemptsBefore + 1, "the flush was attempted exactly once");
  assert.equal(store.saved.at(-1)?.scenes.length, 1, "disk is still behind memory");

  // Nothing was lost: the state is still pending, so the next refused undo flushes it.
  await assert.rejects(() => service.undo(token));
  assert.equal(store.saved.at(-1)?.scenes.length, 0, "the pending undo finally reached disk");
});
