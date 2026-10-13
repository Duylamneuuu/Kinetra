import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError, type EngineCommand } from "../src/index.js";

const sceneId = stableId("scene", "remove");
const entityId = stableId("entity", "crate");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "remove"),
    name: "Component removal",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

function seeded(): CommandBus {
  const bus = new CommandBus(project());
  bus.execute({
    requestId: "create-crate",
    command: "entity.create",
    payload: {
      sceneId,
      entity: {
        id: entityId,
        name: "Crate",
        components: {
          Transform: { position: [0, 0, 0] },
          Tag: { label: "crate", note: "temp", extra: 3 },
          Scalar: 5,
        },
      },
    },
  });
  return bus;
}

function remove(component: string, id: string = entityId): EngineCommand {
  return {
    requestId: `remove-${id}-${component}`,
    command: "component.remove",
    payload: { entityId: id, component },
  };
}

function unset(component: string, fields: string[], id: string = entityId): EngineCommand {
  return {
    requestId: `unset-${id}-${component}`,
    command: "component.unsetFields",
    payload: { entityId: id, component, fields },
  };
}

function components(bus: CommandBus): Record<string, unknown> {
  const item = bus.queryEntities({ ids: [entityId] }).items[0];
  assert.ok(item);
  return item.entity.components;
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CommandError, `unexpected error ${String(error)}`);
    assert.ok(error.remediation.length > 0, "structured errors carry a remediation");
    return error.code;
  }
  assert.fail("expected a CommandError");
}

test("component.remove deletes the component, records a deleted change and bumps the revision", () => {
  const bus = seeded();
  const before = bus.revision;
  const result = bus.execute(remove("Tag"));
  assert.equal(result.revision, before + 1);
  assert.deepEqual(result.changes, [{ kind: "deleted", id: entityId, resource: "component" }]);
  assert.equal("Tag" in components(bus), false);
  assert.ok("Transform" in components(bus));
});

test("component.remove can delete a non-object component value", () => {
  const bus = seeded();
  bus.execute(remove("Scalar"));
  assert.equal("Scalar" in components(bus), false);
});

test("component.remove is undoable and redoable through re-execution", () => {
  const bus = seeded();
  const snapshotBefore = structuredClone(components(bus));
  const result = bus.execute(remove("Tag"));
  assert.ok(result.undoToken);
  bus.undo(result.undoToken);
  assert.deepEqual(components(bus), snapshotBefore);
  bus.execute(remove("Tag"));
  assert.equal("Tag" in components(bus), false);
});

test("component.remove dry run reports changes without mutating or consuming a revision", () => {
  const bus = seeded();
  const before = bus.revision;
  const result = bus.execute({ ...remove("Tag"), dryRun: true });
  assert.deepEqual(result.changes, [{ kind: "deleted", id: entityId, resource: "component" }]);
  assert.equal(result.undoToken, undefined);
  assert.equal(bus.revision, before);
  assert.ok("Tag" in components(bus));
});

test("component.remove reports ENTITY_NOT_FOUND and COMPONENT_NOT_FOUND without changing state", () => {
  const bus = seeded();
  const before = bus.revision;
  assert.equal(errorCode(() => bus.execute(remove("Tag", stableId("entity", "ghost")))), "ENTITY_NOT_FOUND");
  assert.equal(errorCode(() => bus.execute(remove("Missing"))), "COMPONENT_NOT_FOUND");
  // Names inherited from Object.prototype are not components.
  assert.equal(errorCode(() => bus.execute(remove("toString"))), "COMPONENT_NOT_FOUND");
  assert.equal(bus.revision, before);
});

test("component.remove rejects reserved names and malformed payloads as INVALID_COMMAND", () => {
  const bus = seeded();
  assert.equal(errorCode(() => bus.execute(remove("__proto__"))), "INVALID_COMMAND");
  // Shape validation lives on the untrusted-input entry point (executeUnknown).
  assert.equal(errorCode(() => bus.executeUnknown(remove(""))), "INVALID_COMMAND");
  assert.equal(
    errorCode(() =>
      bus.executeUnknown({
        requestId: "bad",
        command: "component.remove",
        payload: { entityId: 1, component: "Tag" },
      }),
    ),
    "INVALID_COMMAND",
  );
  assert.equal(
    errorCode(() =>
      bus.executeUnknown({ requestId: "bad2", command: "component.remove", payload: {} }),
    ),
    "INVALID_COMMAND",
  );
});

test("component.remove can delete a built-in component such as Transform (absent is legal)", () => {
  const bus = seeded();
  const before = bus.revision;
  bus.execute(remove("Transform"));
  assert.equal("Transform" in components(bus), false);
  assert.equal(bus.revision, before + 1);
});

test("component.unsetFields removes only the named fields and keeps the rest", () => {
  const bus = seeded();
  const result = bus.execute(unset("Tag", ["note", "extra"]));
  assert.deepEqual(result.changes, [{ kind: "updated", id: entityId, resource: "component" }]);
  assert.deepEqual(components(bus).Tag, { label: "crate" });
});

test("component.unsetFields may empty a component without deleting it", () => {
  const bus = seeded();
  bus.execute(unset("Tag", ["label", "note", "extra"]));
  assert.deepEqual(components(bus).Tag, {});
});

test("component.unsetFields is undoable and dry-run safe", () => {
  const bus = seeded();
  const original = structuredClone(components(bus).Tag);
  const dry = bus.execute({ ...unset("Tag", ["note"]), dryRun: true });
  assert.equal(dry.undoToken, undefined);
  assert.deepEqual(components(bus).Tag, original);
  const real = bus.execute(unset("Tag", ["note"]));
  assert.ok(real.undoToken);
  bus.undo(real.undoToken);
  assert.deepEqual(components(bus).Tag, original);
});

test("component.unsetFields reports structured errors and leaves state untouched", () => {
  const bus = seeded();
  const before = bus.revision;
  const snapshot = structuredClone(components(bus));
  assert.equal(errorCode(() => bus.execute(unset("Tag", ["note"], stableId("entity", "ghost")))), "ENTITY_NOT_FOUND");
  assert.equal(errorCode(() => bus.execute(unset("Missing", ["x"]))), "COMPONENT_NOT_FOUND");
  assert.equal(errorCode(() => bus.execute(unset("Scalar", ["x"]))), "COMPONENT_NOT_OBJECT");
  // One missing field fails the whole command: no partial removal of the fields that exist.
  assert.equal(errorCode(() => bus.execute(unset("Tag", ["note", "nope"]))), "FIELD_NOT_FOUND");
  // Inherited names are not fields.
  assert.equal(errorCode(() => bus.execute(unset("Tag", ["toString"]))), "FIELD_NOT_FOUND");
  assert.equal(bus.revision, before);
  assert.deepEqual(components(bus), snapshot);
});

test("component.unsetFields rejects malformed payloads as INVALID_COMMAND", () => {
  const bus = seeded();
  const bad = (payload: Record<string, unknown>) =>
    errorCode(() =>
      bus.executeUnknown({ requestId: "bad", command: "component.unsetFields", payload }),
    );
  assert.equal(bad({ entityId, component: "Tag", fields: [] }), "INVALID_COMMAND");
  assert.equal(bad({ entityId, component: "Tag" }), "INVALID_COMMAND");
  assert.equal(bad({ entityId, component: "Tag", fields: [""] }), "INVALID_COMMAND");
  assert.equal(bad({ entityId, component: "Tag", fields: [3] }), "INVALID_COMMAND");
  assert.equal(bad({ entityId, component: "", fields: ["note"] }), "INVALID_COMMAND");
  assert.equal(bad({ entityId, component: "__proto__", fields: ["note"] }), "INVALID_COMMAND");
});

test("unsetFields with a duplicated field name is accepted and removes it once", () => {
  const bus = seeded();
  bus.execute(unset("Tag", ["note", "note"]));
  assert.deepEqual(components(bus).Tag, { label: "crate", extra: 3 });
});

test("component.remove and unsetFields work inside an atomic transaction and roll back together", () => {
  const bus = seeded();
  const before = bus.revision;
  const snapshot = structuredClone(components(bus));
  assert.equal(
    errorCode(() => bus.executeTransaction([unset("Tag", ["note"]), remove("Missing")])),
    "COMPONENT_NOT_FOUND",
  );
  assert.equal(bus.revision, before);
  assert.deepEqual(components(bus), snapshot);

  const result = bus.executeTransaction([unset("Tag", ["note"]), remove("Scalar")]);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(components(bus).Tag, { label: "crate", extra: 3 });
  assert.equal("Scalar" in components(bus), false);
});
