import assert from "node:assert/strict";
import test from "node:test";

import { ProjectValidationError, stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError, type EngineCommand } from "../src/index.js";

const sceneId = stableId("scene", "map");
const entityId = stableId("entity", "map-e");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "map"),
    name: "Validation mapping",
    scenes: [{ id: sceneId, name: "S", entities: [] }],
  };
}

function seeded(): CommandBus {
  const bus = new CommandBus(project());
  bus.executeUnknown({
    requestId: "seed",
    command: "entity.create",
    payload: { sceneId, entity: { id: entityId, name: "E", components: {} } },
  });
  return bus;
}

function patch(body: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    requestId: "p",
    command: "component.patch",
    payload: { entityId, component: "C", patch: body },
    ...extra,
  };
}

function expectInvalidCommand(fn: () => unknown, label: string): CommandError {
  let thrown: unknown;
  assert.throws(fn, (error: unknown) => {
    thrown = error;
    return true;
  }, label);
  assert.ok(thrown instanceof CommandError, `${label}: expected CommandError, got ${String(thrown)}`);
  assert.ok(!(thrown instanceof ProjectValidationError), label);
  assert.equal(thrown.code, "INVALID_COMMAND", label);
  assert.ok(thrown.remediation.length > 0, `${label}: remediation present`);
  return thrown;
}

test("a patch that would make the project invalid is a structured INVALID_COMMAND naming the offending path", () => {
  const bus = seeded();
  const before = bus.snapshot();
  const eventsBefore = bus.eventLog().length;

  for (const [label, body] of [
    ["Date", { when: new Date(0) }],
    ["Map", { map: new Map([[1, 2]]) }],
  ] as Array<[string, unknown]>) {
    const error = expectInvalidCommand(() => bus.executeUnknown(patch(body)), label);
    assert.match(error.message, /^Command would produce an invalid project: /, label);
    assert.match(error.message, /components\.C/, `${label}: message names the offending component path`);
  }

  assert.deepEqual(bus.snapshot(), before, "project and revision untouched");
  assert.equal(bus.eventLog().length, eventsBefore, "no event logged");
});

test("the issue list in the message is capped at three and says how many more", () => {
  const bus = new CommandBus(project());
  const ids = [1, 2, 3, 4, 5].map((n) => stableId("entity", `cap-${n}`));
  bus.executeTransaction(
    ids.map((id) => ({
      requestId: `c-${id}`,
      command: "entity.create",
      payload: { sceneId, entity: { id, name: id, components: {} } },
    })) as EngineCommand[],
  );
  const patches = ids.map((id) => ({
    requestId: `p-${id}`,
    command: "component.patch",
    payload: { entityId: id, component: "C", patch: { when: new Date(0) } },
  }));
  const error = expectInvalidCommand(
    () => bus.executeTransaction(patches as unknown as EngineCommand[]),
    "five bad entities",
  );
  assert.equal(error.message.split("; ").length, 3, "exactly three issues listed");
  assert.match(error.message, /\(\+2 more\)$/);
});

test("a dry run is validated too, and a bad command later in a transaction rolls the whole thing back", () => {
  const bus = seeded();
  const before = bus.snapshot();

  expectInvalidCommand(
    () => bus.executeUnknown(patch({ when: new Date(0) }, { dryRun: true })),
    "dry run",
  );

  const ok: EngineCommand = {
    requestId: "ok",
    command: "entity.create",
    payload: { sceneId, entity: { id: stableId("entity", "map-2"), name: "E2", components: {} } },
  };
  const bad = { ...(patch({ when: new Date(0) }) as object) } as EngineCommand;
  expectInvalidCommand(() => bus.executeTransaction([ok, bad]), "transaction");

  assert.deepEqual(bus.snapshot(), before, "first command of the failed transaction is not applied");
  // The bus is still usable afterwards.
  const result = bus.executeTransaction([ok]);
  assert.equal(result.revision, before.revision + 1);
});

test("the constructor still reports an invalid starting project as the model's ProjectValidationError", () => {
  const broken = { ...project(), name: "" } as ProjectDocument;
  assert.throws(() => new CommandBus(broken), ProjectValidationError);
});
