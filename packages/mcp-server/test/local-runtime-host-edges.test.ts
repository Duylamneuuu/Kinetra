import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { LocalRuntimeHost } from "../src/index.js";

const sceneId = stableId("scene", "local-edges");
const parentId = stableId("entity", "local-edges-parent");
const childId = stableId("entity", "local-edges-child");
const lonerId = stableId("entity", "local-edges-loner");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "local-edges"),
    name: "Local host edges",
    scenes: [
      {
        id: sceneId,
        name: "Main",
        entities: [
          {
            id: lonerId,
            name: "Loner",
            components: { Transform: { position: [9, 8, 7] } },
          },
          {
            id: childId,
            name: "Child",
            parentId,
            components: { Transform: { position: [1, 0, 0] } },
          },
          { id: parentId, name: "Parent", components: { Transform: { position: [0, 2, 0] } } },
        ],
      },
    ],
  };
}

test("LocalRuntimeHost.query before start and after stop reports a stopped, empty runtime", async () => {
  const host = new LocalRuntimeHost();
  assert.deepEqual(await host.query(), { running: false, entities: [] });
  assert.deepEqual(await host.query({ entityIds: [parentId] }), { running: false, entities: [] });

  await host.start(fixture(), sceneId, 3);
  assert.equal((await host.query()).running, true);

  await host.stop();
  assert.deepEqual(await host.query(), { running: false, entities: [] });
  // stop() twice is harmless and does not log a second "stopped" entry.
  await host.stop();
  const stopped = (await host.readLogs(0)).filter((entry) => entry.message === "runtime.stopped");
  assert.equal(stopped.length, 1);
});

test("LocalRuntimeHost.query sorts by entity id, filters by id, and reports parents and revision", async () => {
  const host = new LocalRuntimeHost();
  await host.start(fixture(), sceneId, 7);

  try {
    const all = await host.query();
    assert.equal(all.running, true);
    assert.equal(all.sceneId, sceneId);
    assert.equal(all.projectRevision, 7);
    const ids = all.entities.map((entity) => entity.entityId);
    assert.deepEqual(ids, [...ids].sort());
    assert.ok(ids.includes(parentId) && ids.includes(childId) && ids.includes(lonerId));

    const filtered = await host.query({ entityIds: [childId, "entity_missing"] });
    assert.deepEqual(
      filtered.entities.map((entity) => entity.entityId),
      [childId],
    );
    assert.equal(filtered.entities[0]?.parentEntityId, parentId);
    assert.deepEqual(filtered.entities[0]?.position, [1, 0, 0]);

    const loner = (await host.query({ entityIds: [lonerId] })).entities[0];
    assert.ok(loner);
    assert.equal(loner.parentEntityId, undefined, "root entities carry no parentEntityId");
    assert.deepEqual(loner.position, [9, 8, 7]);

    // An explicit empty filter means "nothing", not "everything".
    assert.deepEqual((await host.query({ entityIds: [] })).entities, []);
  } finally {
    await host.stop();
  }
});

test("LocalRuntimeHost.injectInput before start throws and logs nothing", async () => {
  const host = new LocalRuntimeHost();
  await assert.rejects(
    host.injectInput({ action: "player.jump", phase: "press" }),
    /not running/i,
  );
  assert.deepEqual(await host.readLogs(0), []);
});

test("LocalRuntimeHost.injectInput logs only the fields it was given", async () => {
  const host = new LocalRuntimeHost();
  await host.start(fixture(), sceneId, 0);
  try {
    await host.injectInput({ action: "move", phase: "hold", value: [0.5, -1], durationMs: 250 });
    await host.injectInput({ action: "jump", phase: "press" });

    const inputs = (await host.readLogs(0)).filter((entry) => entry.message === "runtime.input");
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs[0]?.data, {
      action: "move",
      phase: "hold",
      value: [0.5, -1],
      durationMs: 250,
    });
    assert.deepEqual(inputs[1]?.data, { action: "jump", phase: "press" });
    assert.equal(inputs[0]?.level, "debug");
  } finally {
    await host.stop();
  }
});

test("LocalRuntimeHost.readLogs returns copies, so callers cannot rewrite the host's history", async () => {
  const host = new LocalRuntimeHost();
  await host.start(fixture(), sceneId, 0);
  try {
    await host.injectInput({ action: "move", phase: "hold", value: [1, 1] });
    const first = await host.readLogs(0);
    const input = first.find((entry) => entry.message === "runtime.input");
    assert.ok(input?.data);
    (input.data as Record<string, unknown>)["action"] = "tampered";
    first.length = 0;

    const second = await host.readLogs(0);
    assert.ok(second.length >= 2);
    assert.equal(
      second.find((entry) => entry.message === "runtime.input")?.data?.["action"],
      "move",
    );
    // A cursor at or past the newest entry yields nothing; a negative one yields everything.
    const newest = second[second.length - 1]!.sequence;
    assert.deepEqual(await host.readLogs(newest), []);
    assert.deepEqual(await host.readLogs(newest + 100), []);
    assert.equal((await host.readLogs(-5)).length, second.length);
  } finally {
    await host.stop();
  }
});

test("LocalRuntimeHost.captureFrame explains the missing raster surface and carries the live state", async () => {
  const host = new LocalRuntimeHost();
  const idle = await host.captureFrame();
  assert.equal(idle.available, false);
  assert.match(idle.reason ?? "", /no raster surface/i);
  assert.equal(idle.base64, undefined);
  assert.equal(idle.fallbackState?.running, false);

  await host.start(fixture(), sceneId, 2);
  try {
    const live = await host.captureFrame();
    assert.equal(live.available, false);
    assert.equal(live.fallbackState?.running, true);
    assert.equal(live.fallbackState?.projectRevision, 2);
    assert.equal(live.fallbackState?.entities.length, 3);

    // step() is a query on the local host: it never advances anything or throws on odd inputs.
    const stepped = await host.step(0, Number.NaN);
    assert.equal(stepped.running, true);
    assert.equal(stepped.entities.length, 3);
  } finally {
    await host.stop();
  }
});

test("LocalRuntimeHost start of an unknown scene fails, leaves the host stopped, and keeps working afterwards", async () => {
  const host = new LocalRuntimeHost();
  await host.start(fixture(), sceneId, 1);
  await assert.rejects(host.start(fixture(), stableId("scene", "nope"), 2));
  assert.deepEqual(await host.query(), { running: false, entities: [] });

  await host.start(fixture(), sceneId, 3);
  assert.equal((await host.query()).projectRevision, 3);
  await host.stop();
});
