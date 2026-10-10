import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectDocument } from "@kinetra/project-model";

import { LocalRuntimeHost } from "../src/index.js";

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project-runtime-start",
    name: "Runtime start",
    scenes: [
      { id: "scene-a", name: "A", entities: [{ id: "entity-a", name: "A", components: {} }] },
      { id: "scene-b", name: "B", entities: [{ id: "entity-b", name: "B", components: {} }] },
    ],
  };
}

test("overlapping start() calls dispose the runtime they replace instead of leaking it", async () => {
  const host = new LocalRuntimeHost();
  await Promise.all([
    host.start(project(), "scene-a", 1),
    host.start(project(), "scene-b", 2),
  ]);

  const logs = await host.readLogs(0);
  const started = logs.filter((entry) => entry.message === "runtime.started").length;
  const stopped = logs.filter((entry) => entry.message === "runtime.stopped").length;
  assert.equal(started - stopped, 1, "exactly one runtime may remain alive");
  const state = await host.query();
  assert.equal(state.sceneId, "scene-b", "the last start wins");
  assert.equal(state.projectRevision, 2);

  await host.stop();
  const after = await host.readLogs(0);
  assert.equal(
    after.filter((entry) => entry.message === "runtime.started").length,
    after.filter((entry) => entry.message === "runtime.stopped").length,
  );
});
