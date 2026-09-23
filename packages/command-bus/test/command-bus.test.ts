import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError, type CommandErrorCode } from "../src/index.js";

const sceneId = stableId("scene", "main");
const rootId = stableId("entity", "root");
const childId = stableId("entity", "child");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "command-test"),
    name: "Command test",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

test("executes atomic create transaction and exposes narrow queries", () => {
  const bus = new CommandBus(project());

  const result = bus.executeTransaction(
    [
      {
        requestId: "1",
        command: "entity.create",
        payload: {
          sceneId,
          entity: {
            id: rootId,
            name: "Root",
            components: { Transform: { position: [0, 0, 0] } },
          },
        },
      },
      {
        requestId: "2",
        command: "entity.create",
        payload: {
          sceneId,
          entity: {
            id: childId,
            name: "Child",
            parentId: rootId,
            components: {
              Transform: { position: [1, 0, 0] },
              Health: { value: 10 },
            },
          },
        },
      },
    ],
    { expectedProjectRevision: 0 },
  );

  assert.equal(result.revision, 1);
  assert.equal(result.changes.length, 2);

  const query = bus.queryEntities({
    sceneId,
    component: "Health",
    selectComponents: ["Health"],
  });

  assert.equal(query.total, 1);
  assert.deepEqual(query.items[0]?.entity.components, { Health: { value: 10 } });
  assert.equal(query.unmatched, undefined);
});

test("every command error code includes a next-step remediation", () => {
  const covered = {
    STALE_REVISION: true,
    SCENE_NOT_FOUND: true,
    SCENE_ALREADY_EXISTS: true,
    ENTITY_NOT_FOUND: true,
    ENTITY_ALREADY_EXISTS: true,
    PARENT_NOT_FOUND: true,
    CHILDREN_EXIST: true,
    COMPONENT_NOT_OBJECT: true,
    INVALID_COMMAND: true,
  } satisfies Record<CommandErrorCode, true>;

  for (const code of Object.keys(covered) as CommandErrorCode[]) {
    const error = new CommandError(code, "example");
    assert.equal(error.code, code);
    assert.ok(error.remediation.length > 12, `${code} remediation`);
  }

  const overridden = new CommandError("INVALID_COMMAND", "bad payload", "Send a supported command.");
  assert.equal(overridden.remediation, "Send a supported command.");
});

test("rejects stale revisions without mutating state", () => {
  const bus = new CommandBus(project());

  bus.execute({
    requestId: "create",
    command: "entity.create",
    expectedProjectRevision: 0,
    payload: {
      sceneId,
      entity: { id: rootId, name: "Root", components: {} },
    },
  });

  assert.throws(
    () =>
      bus.execute({
        requestId: "stale",
        command: "component.patch",
        expectedProjectRevision: 0,
        payload: { entityId: rootId, component: "Transform", patch: { visible: true } },
      }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.code === "STALE_REVISION" &&
      error.remediation.includes("project.inspect") &&
      error.remediation.includes("expectedProjectRevision"),
  );

  assert.equal(bus.revision, 1);
  assert.deepEqual(bus.snapshot().project.scenes[0]?.entities[0]?.components, {});
});

test("dry-run reports changes but preserves project and revision", () => {
  const bus = new CommandBus(project());

  const result = bus.execute({
    requestId: "dry",
    command: "entity.create",
    dryRun: true,
    payload: {
      sceneId,
      entity: { id: rootId, name: "Root", components: {} },
    },
  });

  assert.equal(result.revision, 0);
  assert.equal(result.proposedRevision, 1);
  assert.equal(bus.queryEntities().total, 0);
});

test("transaction failures are atomic and undo restores prior state", () => {
  const bus = new CommandBus(project());

  assert.throws(() =>
    bus.executeTransaction([
      {
        requestId: "root",
        command: "entity.create",
        payload: { sceneId, entity: { id: rootId, name: "Root", components: {} } },
      },
      {
        requestId: "bad-child",
        command: "entity.create",
        payload: {
          sceneId,
          entity: {
            id: childId,
            name: "Child",
            parentId: "entity_missing",
            components: {},
          },
        },
      },
    ]),
  );

  assert.equal(bus.revision, 0);
  assert.equal(bus.queryEntities().total, 0);

  const create = bus.execute({
    requestId: "create",
    command: "entity.create",
    payload: { sceneId, entity: { id: rootId, name: "Root", components: {} } },
  });

  assert.ok(create.undoToken);
  assert.equal(bus.queryEntities().total, 1);

  bus.undo(create.undoToken, 1);
  assert.equal(bus.revision, 2);
  assert.equal(bus.queryEntities().total, 0);
});

test("rejects malformed untrusted command JSON before mutation", () => {
  const bus = new CommandBus(project());

  assert.throws(
    () =>
      bus.executeUnknown({
        requestId: "malformed",
        command: "entity.create",
        payload: {
          sceneId,
          entity: {
            id: rootId,
            name: "Root",
            components: { Transform: { position: [Number.NaN, 0, 0] } },
          },
        },
      }),
    (error: unknown) => error instanceof CommandError && error.code === "INVALID_COMMAND",
  );

  assert.equal(bus.revision, 0);
  assert.equal(bus.queryEntities().total, 0);
});

test("entity query names unmatched scene and entity ids without changing matches", () => {
  const bus = new CommandBus(project());
  const otherSceneId = stableId("scene", "other");
  const pagedId = stableId("entity", "paged");

  bus.execute({
    requestId: "other-scene",
    command: "scene.create",
    payload: { scene: { id: otherSceneId, name: "Other", entities: [] } },
  });
  bus.executeTransaction([
    {
      requestId: "root",
      command: "entity.create",
      payload: { sceneId, entity: { id: rootId, name: "Root", components: {} } },
    },
    {
      requestId: "child",
      command: "entity.create",
      payload: {
        sceneId,
        entity: { id: childId, name: "Child", components: { Health: { value: 1 } } },
      },
    },
    {
      requestId: "paged",
      command: "entity.create",
      payload: { sceneId, entity: { id: pagedId, name: "Paged", components: {} } },
    },
    {
      requestId: "away",
      command: "entity.create",
      payload: {
        sceneId: otherSceneId,
        entity: { id: stableId("entity", "away"), name: "Away", components: {} },
      },
    },
  ]);

  const missingScene = bus.queryEntities({ sceneId: "scene-missing", ids: [rootId] });
  assert.equal(missingScene.total, 0);
  assert.deepEqual(missingScene.items, []);
  assert.equal(missingScene.unmatched?.sceneId, "scene-missing");
  assert.deepEqual(missingScene.unmatched?.availableSceneIds, [otherSceneId, sceneId].sort());
  assert.equal(missingScene.unmatched?.entities, undefined);

  const missingEntity = bus.queryEntities({ sceneId, ids: [rootId, "entity-missing"] });
  assert.equal(missingEntity.total, 1);
  assert.equal(missingEntity.items[0]?.entity.id, rootId);
  assert.deepEqual(missingEntity.unmatched?.entities, [{ id: "entity-missing" }]);

  const otherScene = bus.queryEntities({
    sceneId,
    ids: [stableId("entity", "away")],
  });
  assert.equal(otherScene.total, 0);
  assert.deepEqual(otherScene.unmatched?.entities, [
    { id: stableId("entity", "away"), sceneId: otherSceneId },
  ]);

  const filtered = bus.queryEntities({
    sceneId,
    ids: [childId],
    component: "MissingComponent",
  });
  assert.equal(filtered.total, 0);
  assert.equal(filtered.unmatched, undefined);

  const page = bus.queryEntities({
    ids: [rootId, childId, pagedId],
    limit: 1,
  });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.unmatched, undefined);

  const manyIds = Array.from({ length: 14 }, (_, index) => `missing-${String(index).padStart(2, "0")}`);
  const capped = bus.queryEntities({ ids: [...manyIds, rootId] });
  assert.equal(capped.total, 1);
  assert.equal(capped.unmatched?.entities?.length, 12);
  assert.deepEqual(
    capped.unmatched?.entities?.map((miss) => miss.id),
    manyIds.slice(0, 12),
  );
  assert.equal(capped.unmatched?.omittedEntityCount, 2);

  for (let index = 0; index < 12; index += 1) {
    bus.execute({
      requestId: `extra-scene-${index}`,
      command: "scene.create",
      payload: {
        scene: { id: `scene-extra-${String(index).padStart(2, "0")}`, name: "Extra", entities: [] },
      },
    });
  }
  const manyScenes = bus.queryEntities({ sceneId: "scene-missing" });
  assert.equal(manyScenes.total, 0);
  assert.deepEqual(
    manyScenes.unmatched?.availableSceneIds,
    Array.from({ length: 12 }, (_, index) => `scene-extra-${String(index).padStart(2, "0")}`),
  );
  assert.equal(manyScenes.unmatched?.omittedSceneCount, 2);
});

test("reparent and cascade delete obey hierarchy rules", () => {
  const bus = new CommandBus(project());

  bus.executeTransaction([
    {
      requestId: "root",
      command: "entity.create",
      payload: { sceneId, entity: { id: rootId, name: "Root", components: {} } },
    },
    {
      requestId: "child",
      command: "entity.create",
      payload: { sceneId, entity: { id: childId, name: "Child", components: {} } },
    },
  ]);

  bus.execute({
    requestId: "reparent",
    command: "entity.reparent",
    expectedProjectRevision: 1,
    payload: { entityId: childId, parentId: rootId },
  });

  assert.equal(
    bus.queryEntities({ ids: [childId] }).items[0]?.entity.parentId,
    rootId,
  );

  assert.throws(
    () =>
      bus.execute({
        requestId: "delete-parent",
        command: "entity.delete",
        expectedProjectRevision: 2,
        payload: { entityId: rootId },
      }),
    (error: unknown) => error instanceof CommandError && error.code === "CHILDREN_EXIST",
  );

  assert.equal(bus.revision, 2);

  const deleted = bus.execute({
    requestId: "delete-subtree",
    command: "entity.delete",
    expectedProjectRevision: 2,
    payload: { entityId: rootId, cascade: true },
  });

  assert.equal(deleted.changes.filter((change) => change.kind === "deleted").length, 2);
  assert.equal(bus.queryEntities().total, 0);
});
