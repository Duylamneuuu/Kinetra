import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError } from "../src/index.js";

const sceneId = stableId("scene", "input-bounds");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "input-bounds"),
    name: "Input bounds",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

function seeded(): CommandBus {
  const bus = new CommandBus(project());
  bus.executeUnknown({
    requestId: "seed",
    command: "entity.create",
    payload: { sceneId, entity: { id: "e1", name: "E1", components: {} } },
  });
  return bus;
}

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < depth; i += 1) {
    value = { child: value };
  }
  return value;
}

function assertInvalidCommand(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${String(error)}`);
    assert.equal(error.code, "INVALID_COMMAND");
    return true;
  });
}

test("a cyclic component patch is a structured INVALID_COMMAND, not a stack overflow", () => {
  const bus = seeded();
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;

  assertInvalidCommand(() =>
    bus.executeUnknown({
      requestId: "cyclic",
      command: "component.patch",
      payload: { entityId: "e1", component: "data", patch: cyclic },
    }),
  );
  assert.equal(bus.revision, 1, "a rejected command must not change the revision");
});

test("an absurdly deep component payload is rejected with INVALID_COMMAND", () => {
  const bus = seeded();

  assertInvalidCommand(() =>
    bus.executeUnknown({
      requestId: "deep-entity",
      command: "entity.create",
      payload: {
        sceneId,
        entity: { id: "e2", name: "E2", components: { data: nested(100_000) } },
      },
    }),
  );
  assert.equal(bus.revision, 1);
});

test("reasonably nested component data is still accepted", () => {
  const bus = seeded();
  const result = bus.executeUnknown({
    requestId: "ok-nested",
    command: "component.patch",
    payload: { entityId: "e1", component: "data", patch: nested(50) },
  });
  assert.equal(result.ok, true);
  assert.equal(bus.revision, 2);
});

test("an empty transaction is rejected and leaves revision, undo stack and event log alone", () => {
  const bus = seeded();
  const eventsBefore = bus.eventLog().length;

  assertInvalidCommand(() => bus.executeTransaction([]));

  assert.equal(bus.revision, 1);
  assert.equal(bus.eventLog().length, eventsBefore);
});
