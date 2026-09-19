import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError } from "../src/index.js";

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
    (error: unknown) => error instanceof CommandError && error.code === "STALE_REVISION",
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
