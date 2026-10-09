import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import type { AcceptanceManifest } from "@kinetra/verification";

import { KinetraAgentService, LocalRuntimeHost } from "../src/index.js";

const sceneId = stableId("scene", "validation-main");
const parentId = stableId("entity", "validation-parent");
const childId = stableId("entity", "validation-child");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "validation-fixture"),
    name: "Validation fixture",
    scenes: [
      {
        id: sceneId,
        name: "Main",
        entities: [
          {
            id: parentId,
            name: "Parent",
            components: {
              Transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
            },
          },
          {
            id: childId,
            name: "Child",
            parentId,
            components: {
              Transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            },
          },
        ],
      },
    ],
  };
}

function manifest(overrides: Record<string, unknown> = {}): AcceptanceManifest {
  return {
    schemaVersion: 1,
    name: "validation",
    steps: [],
    ...overrides,
  } as unknown as AcceptanceManifest;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

test("runAcceptance rejects a missing or non-object manifest before launching anything", async () => {
  const service = new KinetraAgentService(fixture());

  await rejectsWithCode(
    service.runAcceptance({ manifest: undefined as unknown as AcceptanceManifest }),
    "INVALID_MANIFEST",
  );
  await rejectsWithCode(
    service.runAcceptance({ manifest: null as unknown as AcceptanceManifest }),
    "INVALID_MANIFEST",
  );
  await rejectsWithCode(
    service.runAcceptance({ manifest: "manifest" as unknown as AcceptanceManifest }),
    "INVALID_MANIFEST",
  );
});

test("runAcceptance rejects unsupported schema versions, including a missing one", async () => {
  const service = new KinetraAgentService(fixture());

  await rejectsWithCode(
    service.runAcceptance({ manifest: manifest({ schemaVersion: 2 }) }),
    "UNSUPPORTED_SCHEMA_VERSION",
  );
  await rejectsWithCode(
    service.runAcceptance({ manifest: manifest({ schemaVersion: "1" }) }),
    "UNSUPPORTED_SCHEMA_VERSION",
  );
  await rejectsWithCode(
    service.runAcceptance({ manifest: manifest({ schemaVersion: undefined }) }),
    "UNSUPPORTED_SCHEMA_VERSION",
  );
  await rejectsWithCode(
    service.runAcceptance({ manifest: [] as unknown as AcceptanceManifest }),
    "UNSUPPORTED_SCHEMA_VERSION",
  );
});

test("runAcceptance rejects an unknown target from the input or from the manifest", async () => {
  const service = new KinetraAgentService(fixture());

  await rejectsWithCode(
    service.runAcceptance({
      manifest: manifest(),
      target: "browser" as unknown as "runtime",
    }),
    "INVALID_TARGET",
  );
  await rejectsWithCode(
    service.runAcceptance({ manifest: manifest({ target: "console" }) }),
    "INVALID_TARGET",
  );
});

test("runAcceptance rejects a project override that is not a ProjectDocument", async () => {
  const service = new KinetraAgentService(fixture());

  await rejectsWithCode(
    service.runAcceptance({
      manifest: manifest(),
      project: { schemaVersion: 1 } as unknown as ProjectDocument,
    }),
    "INVALID_PROJECT",
  );
  await rejectsWithCode(
    service.runAcceptance({
      manifest: manifest(),
      project: { scenes: "none" } as unknown as ProjectDocument,
    }),
    "INVALID_PROJECT",
  );
});

test("inspectProject and queryScenes order scenes by code unit, not by locale", async () => {
  const project = fixture();
  project.scenes = [
    { id: "scene:b", name: "B", entities: [] },
    { id: "scene:Z", name: "Z", entities: [] },
    { id: "scene:a", name: "A", entities: [{ id: "entity:x", name: "X", components: {} }] },
  ];
  const service = new KinetraAgentService(project);

  const inspected = service.inspectProject();
  assert.deepEqual(
    inspected.scenes.map((scene) => scene.id),
    ["scene:Z", "scene:a", "scene:b"],
  );
  assert.equal(inspected.scenes[1]?.entityCount, 1);
  assert.deepEqual(
    service.queryScenes().map((scene) => scene.id),
    ["scene:Z", "scene:a", "scene:b"],
  );
  assert.deepEqual(
    service.queryScenes("scene:a").map((scene) => scene.name),
    ["A"],
  );
  assert.deepEqual(service.queryScenes("scene:missing"), []);
});

test("diffSince returns only events after the given revision", async () => {
  const service = new KinetraAgentService(fixture());
  const first = await service.createScene({ name: "Second", id: stableId("scene", "second") });
  const second = await service.createScene({ name: "Third", id: stableId("scene", "third") });

  assert.equal(second.revision, first.revision + 1);
  const all = service.diffSince(0);
  assert.equal(all.currentRevision, second.revision);
  assert.equal(all.events.length, 2);

  const tail = service.diffSince(first.revision);
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0]?.revision, second.revision);

  assert.deepEqual(service.diffSince(second.revision).events, []);
  assert.equal(service.diffSince(999).events.length, 0);
});

test("dryRun commands do not change the project revision or the persisted shape", async () => {
  const service = new KinetraAgentService(fixture());
  const before = service.inspectProject();

  const dry = await service.createEntity({
    sceneId,
    id: stableId("entity", "dry"),
    name: "Dry",
    dryRun: true,
  });

  assert.equal(dry.revision, before.revision);
  assert.equal(service.inspectProject().scenes[0]?.entityCount, 2);
});

test("LocalRuntimeHost reports not running, then filters, sorts and parents entities", async () => {
  const host = new LocalRuntimeHost();

  assert.deepEqual(await host.query(), { running: false, entities: [] });
  await assert.rejects(
    host.injectInput({ action: "jump", phase: "press" }),
    /not running/,
  );
  await host.stop(); // stopping an idle host is a no-op and logs nothing
  assert.deepEqual(await host.readLogs(), []);

  await host.start(fixture(), sceneId, 7);
  const all = await host.query();
  assert.equal(all.running, true);
  assert.equal(all.sceneId, sceneId);
  assert.equal(all.projectRevision, 7);

  const ids = all.entities.map((entity) => entity.entityId);
  assert.deepEqual(ids, [...ids].sort());
  const child = all.entities.find((entity) => entity.entityId === childId);
  assert.equal(child?.parentEntityId, parentId);
  const parent = all.entities.find((entity) => entity.entityId === parentId);
  assert.equal(parent?.parentEntityId, undefined);
  assert.deepEqual(parent?.position, [1, 2, 3]);

  const only = await host.query({ entityIds: [childId, "entity:does-not-exist"] });
  assert.deepEqual(
    only.entities.map((entity) => entity.entityId),
    [childId],
  );
  assert.deepEqual((await host.query({ entityIds: [] })).entities, []);
  assert.deepEqual((await host.step(5, 1 / 30)).entities, all.entities);

  await host.stop();
  assert.deepEqual(await host.query(), { running: false, entities: [] });
});

test("LocalRuntimeHost log sequence is monotonic across restarts and readLogs returns copies", async () => {
  const host = new LocalRuntimeHost();

  await host.start(fixture(), sceneId, 1);
  await host.injectInput({ action: "move", phase: "hold", value: [1, 0], durationMs: 50 });
  await host.start(fixture(), sceneId, 2); // restart stops the previous runtime first

  const logs = await host.readLogs();
  assert.deepEqual(
    logs.map((entry) => entry.message),
    ["runtime.started", "runtime.input", "runtime.stopped", "runtime.started"],
  );
  assert.deepEqual(
    logs.map((entry) => entry.sequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(logs[1]?.data, {
    action: "move",
    phase: "hold",
    value: [1, 0],
    durationMs: 50,
  });

  // Mutating a returned entry must not alter the host's own log.
  logs[1]!.data!["action"] = "tampered";
  assert.equal((await host.readLogs(1))[0]?.data?.["action"], "move");
  assert.deepEqual(
    (await host.readLogs(3)).map((entry) => entry.sequence),
    [4],
  );
  assert.deepEqual(await host.readLogs(4), []);

  const frame = await host.captureFrame();
  assert.equal(frame.available, false);
  assert.equal(frame.fallbackState?.projectRevision, 2);
  await host.stop();
});
