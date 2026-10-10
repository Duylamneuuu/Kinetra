import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError, type EngineCommand } from "../src/index.js";

const sceneA = stableId("scene", "edge-a");
const sceneB = stableId("scene", "edge-b");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "edge"),
    name: "Edge contracts",
    scenes: [
      { id: sceneA, name: "A", entities: [] },
      { id: sceneB, name: "B", entities: [] },
    ],
  };
}

function entity(id: string, extra: { parentId?: string } = {}) {
  return { id, name: id, components: {}, ...extra };
}

function create(id: string, extra: { parentId?: string } = {}, sceneId = sceneA): EngineCommand {
  return {
    requestId: `create-${id}`,
    command: "entity.create",
    payload: { sceneId, entity: entity(id, extra) },
  };
}

function patch(entityId: string, component: string, body: unknown): unknown {
  return {
    requestId: `patch-${entityId}`,
    command: "component.patch",
    payload: { entityId, component, patch: body },
  };
}

/** Run `fn`, expect it to throw, and assert the bus is byte-for-byte unchanged afterwards. */
function assertRejectedWithoutMutation(bus: CommandBus, fn: () => unknown, label: string): unknown {
  const before = bus.snapshot();
  const eventsBefore = bus.eventLog().length;
  let thrown: unknown;
  assert.throws(fn, (error: unknown) => {
    thrown = error;
    return error instanceof Error;
  }, label);
  assert.deepEqual(bus.snapshot(), before, `${label}: project/revision must not change`);
  assert.equal(bus.eventLog().length, eventsBefore, `${label}: no event may be logged`);
  return thrown;
}

test("entity ids are unique across scenes, so a second scene cannot reuse an id", () => {
  const bus = new CommandBus(project());
  const id = stableId("entity", "shared");
  bus.execute(create(id));

  const error = assertRejectedWithoutMutation(bus, () => bus.execute(create(id, {}, sceneB)), "cross-scene id");
  assert.ok(error instanceof CommandError);
  assert.equal(error.code, "ENTITY_ALREADY_EXISTS");
});

test("scene.create with a duplicate, dangling, self or cyclic entity reference is rejected atomically", () => {
  const bus = new CommandBus(project());
  const taken = stableId("entity", "taken");
  bus.execute(create(taken));

  const sceneCommand = (entities: unknown[]): unknown => ({
    requestId: "scene",
    command: "scene.create",
    payload: { scene: { id: stableId("scene", "edge-c"), name: "C", entities } },
  });
  const x = stableId("entity", "x");
  const y = stableId("entity", "y");

  assertRejectedWithoutMutation(
    bus,
    () => bus.executeUnknown(sceneCommand([entity(taken)])),
    "entity id already used in another scene",
  );
  assertRejectedWithoutMutation(
    bus,
    () => bus.executeUnknown(sceneCommand([entity(x, { parentId: "entity_missing" })])),
    "dangling parent",
  );
  assertRejectedWithoutMutation(
    bus,
    () => bus.executeUnknown(sceneCommand([entity(x, { parentId: x })])),
    "self parent",
  );
  assertRejectedWithoutMutation(
    bus,
    () => bus.executeUnknown(sceneCommand([entity(x, { parentId: y }), entity(y, { parentId: x })])),
    "parent cycle",
  );
  assert.equal(bus.snapshot().project.scenes.length, 2);
});

test("entity.create with an empty parentId string is rejected instead of silently becoming a root", () => {
  const bus = new CommandBus(project());
  assertRejectedWithoutMutation(
    bus,
    () => bus.execute(create(stableId("entity", "orphan"), { parentId: "" })),
    "empty parentId",
  );
});

test("reparenting into another scene is PARENT_NOT_FOUND and leaves the hierarchy intact", () => {
  const bus = new CommandBus(project());
  const parent = stableId("entity", "parent-b");
  const child = stableId("entity", "child-a");
  bus.executeTransaction([create(parent, {}, sceneB), create(child)]);

  const error = assertRejectedWithoutMutation(
    bus,
    () =>
      bus.execute({
        requestId: "cross-scene",
        command: "entity.reparent",
        payload: { entityId: child, parentId: parent },
      }),
    "cross-scene reparent",
  );
  assert.ok(error instanceof CommandError);
  assert.equal(error.code, "PARENT_NOT_FOUND");
});

test("values that are not plain JSON never reach the project (Date, Map, sparse array, undefined)", () => {
  const bus = new CommandBus(project());
  const id = stableId("entity", "json");
  bus.execute(create(id));

  assertRejectedWithoutMutation(bus, () => bus.executeUnknown(patch(id, "C", { when: new Date(0) })), "Date");
  assertRejectedWithoutMutation(bus, () => bus.executeUnknown(patch(id, "C", { map: new Map([[1, 2]]) })), "Map");
  assertRejectedWithoutMutation(
    bus,
    // eslint-disable-next-line no-sparse-arrays
    () => bus.executeUnknown(patch(id, "C", { list: [1, , 3] })),
    "sparse array",
  );
  assertRejectedWithoutMutation(bus, () => bus.executeUnknown(patch(id, "C", { gone: undefined })), "undefined");
  assertRejectedWithoutMutation(bus, () => bus.executeUnknown(patch(id, "C", [1, 2])), "array patch");
  assertRejectedWithoutMutation(bus, () => bus.executeUnknown(patch(id, "C", null)), "null patch");
  assertRejectedWithoutMutation(bus, () => bus.executeUnknown(patch(id, "", { a: 1 })), "empty component name");
});

test("component.patch merges shallowly: a nested object is replaced, not deep-merged", () => {
  const bus = new CommandBus(project());
  const id = stableId("entity", "shallow");
  bus.execute(create(id));
  bus.executeUnknown(patch(id, "Transform", { position: { x: 1, y: 2 }, visible: true }));
  bus.executeUnknown(patch(id, "Transform", { position: { x: 9 } }));

  const transform = bus.snapshot().project.scenes[0]!.entities[0]!.components["Transform"];
  assert.deepEqual(transform, { position: { x: 9 }, visible: true });
});

test("undo of a cascade delete restores the whole subtree in its original order", () => {
  const bus = new CommandBus(project());
  const a = stableId("entity", "a");
  const b = stableId("entity", "b");
  const c = stableId("entity", "c");
  bus.executeTransaction([create(a), create(b, { parentId: a }), create(c, { parentId: b })]);
  const before = bus.snapshot().project;

  const deleted = bus.execute({
    requestId: "delete",
    command: "entity.delete",
    payload: { entityId: a, cascade: true },
  });
  assert.equal(deleted.changes.filter((change) => change.kind === "deleted").length, 3);
  assert.equal(bus.queryEntities().total, 0);

  bus.undo(deleted.undoToken!);
  assert.deepEqual(bus.snapshot().project, before);
});

test("undo tokens with a leading zero or sign are unknown, never matched numerically", () => {
  const bus = new CommandBus(project());
  const token = bus.execute(create(stableId("entity", "t"))).undoToken!;
  assert.equal(token, "undo_1");

  for (const bad of ["undo_01", "undo_+1", "undo_1 ", " undo_1", "UNDO_1", "undo_1.0", "undo_"]) {
    const error = assertRejectedWithoutMutation(bus, () => bus.undo(bad), `token ${JSON.stringify(bad)}`);
    assert.ok(error instanceof CommandError);
    assert.equal(error.code, "INVALID_COMMAND");
  }
  bus.undo(token);
  assert.equal(bus.queryEntities().total, 0);
});

test("a negative or fractional expectedProjectRevision never matches the current revision", () => {
  const bus = new CommandBus(project());
  const token = bus.execute(create(stableId("entity", "r"))).undoToken!;

  for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const error = assertRejectedWithoutMutation(bus, () => bus.undo(token, bad), `undo expected ${String(bad)}`);
    assert.ok(error instanceof CommandError);
    assert.equal(error.code, "STALE_REVISION");
  }
  assert.throws(
    () => bus.executeUnknown({ ...(create(stableId("entity", "r2")) as object), expectedProjectRevision: 1.5 }),
    (error: unknown) => error instanceof CommandError && error.code === "INVALID_COMMAND",
  );
});

test("a dry-run command anywhere in a transaction makes the whole transaction a dry run", () => {
  const bus = new CommandBus(project());
  const result = bus.executeTransaction([
    create(stableId("entity", "d1")),
    { ...create(stableId("entity", "d2")), dryRun: true },
  ]);
  assert.equal(result.revision, 0);
  assert.equal(result.proposedRevision, 1);
  assert.equal(result.changes.length, 2);
  assert.equal(result.undoToken, undefined);
  assert.equal(bus.queryEntities().total, 0);
  assert.equal(bus.eventLog().length, 0);
});

test("a transaction with no commands (or a non-array) is INVALID_COMMAND and does not bump the revision", () => {
  const bus = new CommandBus(project());
  for (const bad of [[], null, undefined, "x"] as unknown[]) {
    const error = assertRejectedWithoutMutation(
      bus,
      () => bus.executeTransaction(bad as EngineCommand[]),
      `transaction ${String(bad)}`,
    );
    assert.ok(error instanceof CommandError);
    assert.equal(error.code, "INVALID_COMMAND");
  }
});

test("snapshot, eventLog and the submitted command are defensive copies", () => {
  const bus = new CommandBus(project());
  const command = create(stableId("entity", "copy"));
  bus.execute(command);

  // Mutating the caller's command afterwards must not rewrite history or state.
  (command.payload as { entity: { name: string } }).entity.name = "changed";
  assert.equal(bus.snapshot().project.scenes[0]!.entities[0]!.name, stableId("entity", "copy"));
  assert.equal(
    (bus.eventLog()[0]!.commands[0]!.payload as { entity: { name: string } }).entity.name,
    stableId("entity", "copy"),
  );

  // Mutating returned copies must not touch the bus.
  const snapshot = bus.snapshot();
  snapshot.project.scenes.length = 0;
  const log = bus.eventLog();
  log[0]!.commands.length = 0;
  assert.equal(bus.snapshot().project.scenes.length, 2);
  assert.equal(bus.eventLog()[0]!.commands.length, 1);
});

test("queryEntities edge filters: empty ids matches nothing, empty text matches all, unknown scene matches nothing", () => {
  const bus = new CommandBus(project());
  bus.executeTransaction([create(stableId("entity", "q1")), create(stableId("entity", "q2"), {}, sceneB)]);

  assert.equal(bus.queryEntities({ ids: [] }).total, 0);
  assert.equal(bus.queryEntities({ nameContains: "" }).total, 2);
  assert.equal(bus.queryEntities({ sceneId: "scene_missing" }).total, 0);
  assert.equal(bus.queryEntities({ sceneId: sceneB }).total, 1);
  assert.deepEqual(bus.queryEntities({ selectComponents: [] }).items[0]!.entity.components, {});
  bus.execute({
    requestId: "named",
    command: "entity.create",
    payload: { sceneId: sceneA, entity: { id: stableId("entity", "named"), name: "Alpha Crate", components: {} } },
  });
  assert.equal(bus.queryEntities({ nameContains: "ALPHA" }).total, 1, "nameContains ignores case");
  assert.equal(bus.queryEntities({ nameContains: "crate" }).total, 1);
  assert.equal(bus.queryEntities({ nameContains: "Alpha  Crate" }).total, 0, "no whitespace normalisation");
});
