import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { LocalRuntimeHost, MAX_LOCAL_RUNTIME_LOG_ENTRIES } from "../src/index.js";

const sceneId = stableId("scene", "log-cap");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "log-cap"),
    name: "Log cap",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

test("LocalRuntimeHost keeps a bounded log buffer with monotonic sequence numbers", async () => {
  const host = new LocalRuntimeHost();
  await host.start(fixture(), sceneId, 0);

  const total = MAX_LOCAL_RUNTIME_LOG_ENTRIES + 250;
  for (let index = 0; index < total; index += 1) {
    await host.injectInput({ action: "player.jump", phase: "press", value: index });
  }

  const logs = await host.readLogs(0);
  assert.ok(
    logs.length <= MAX_LOCAL_RUNTIME_LOG_ENTRIES,
    `log buffer must be bounded, got ${logs.length} entries`,
  );

  // The newest entries survive and sequences stay strictly increasing (cursors keep working).
  const last = logs[logs.length - 1];
  assert.ok(last);
  assert.equal(last.sequence, total + 1); // +1 for the runtime.started entry
  for (let index = 1; index < logs.length; index += 1) {
    assert.ok(logs[index]!.sequence > logs[index - 1]!.sequence);
  }

  // A cursor taken near the end still returns only newer entries.
  const cursor = last.sequence - 3;
  const tail = await host.readLogs(cursor);
  assert.deepEqual(
    tail.map((entry) => entry.sequence),
    [cursor + 1, cursor + 2, cursor + 3],
  );

  await host.stop();
});
