import assert from "node:assert/strict";
import test from "node:test";

import {
  stableId,
  type ProjectDocument,
} from "@kinetra/project-model";

import { CommandBus, CommandError, type EngineCommand } from "../src/index.js";

const sceneId = stableId("scene", "builtin");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "builtin"),
    name: "Builtin components",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

function create(id: string, components: Record<string, unknown>): EngineCommand {
  return {
    requestId: `create-${id}`,
    command: "entity.create",
    payload: { sceneId, entity: { id, name: id, components: components as never } },
  };
}

function patch(entityId: string, component: string, value: Record<string, unknown>): EngineCommand {
  return {
    requestId: `patch-${entityId}-${component}`,
    command: "component.patch",
    payload: { entityId, component, patch: value as never },
  };
}

function issueCodes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CommandError, `unexpected error ${String(error)}`);
    assert.equal(error.code, "INVALID_COMMAND");
    assert.ok(error.issues, "INVALID_COMMAND from a schema failure carries its issues");
    return error.issues.map((issue) => issue.code);
  }
  assert.fail("expected a CommandError");
}

test("entity.create with an unsupported Primitive.kind is rejected and leaves the revision unchanged", () => {
  const bus = new CommandBus(project());
  const codes = issueCodes(() => bus.execute(create("e1", { Primitive: { kind: "cylinder" } })));
  assert.deepEqual(codes, ["component.Primitive.kind.invalid"]);
  assert.equal(bus.revision, 0);
  assert.equal(bus.snapshot().project.scenes[0]?.entities.length, 0);
});

test("component.patch that would corrupt a built-in is rejected atomically", () => {
  const bus = new CommandBus(project());
  bus.execute(create("e1", { Transform: { position: [1, 2, 3] } }));
  const before = bus.snapshot();

  assert.deepEqual(
    issueCodes(() => bus.execute(patch("e1", "Transform", { position: [1, 2] }))),
    ["component.Transform.position.invalid"],
  );
  assert.equal(bus.revision, before.revision);
  assert.deepEqual(bus.snapshot().project, before.project);

  // A valid patch afterwards still works and bumps the revision once.
  bus.execute(patch("e1", "Transform", { position: [4, 5, 6] }));
  assert.equal(bus.revision, before.revision + 1);
});

test("dryRun also validates built-ins", () => {
  const bus = new CommandBus(project());
  const command = { ...create("e1", { Light: { kind: "spot" } }), dryRun: true };
  assert.deepEqual(issueCodes(() => bus.execute(command)), ["component.Light.kind.invalid"]);
  assert.equal(bus.revision, 0);
});

test("a transaction with one bad built-in commits nothing", () => {
  const bus = new CommandBus(project());
  const codes = issueCodes(() =>
    bus.executeTransaction([
      create("good", { Primitive: { kind: "box" } }),
      create("bad", { Camera: { fov: 0 } }),
    ]),
  );
  assert.deepEqual(codes, ["component.Camera.fov.invalid"]);
  assert.equal(bus.revision, 0);
  assert.equal(bus.snapshot().project.scenes[0]?.entities.length, 0);
});

test("custom and unschematised components stay free-form", () => {
  const bus = new CommandBus(project());
  const result = bus.execute(
    create("e1", {
      Collider: { shape: "anything", size: "huge" },
      MyGameThing: { whatever: [1, "two", { three: 3 }] },
    }),
  );
  assert.equal(result.ok, true);
});

test("executeUnknown (the MCP path) enforces the same schemas", () => {
  const bus = new CommandBus(project());
  assert.deepEqual(
    issueCodes(() =>
      bus.executeUnknown({
        requestId: "u1",
        command: "entity.create",
        payload: { sceneId, entity: { id: "e1", name: "e1", components: { Primitive: 5 } } },
      }),
    ),
    ["component.Primitive.invalid"],
  );
  assert.equal(bus.revision, 0);
});

test("undo after a rejected command still undoes the last accepted one", () => {
  const bus = new CommandBus(project());
  const first = bus.execute(create("e1", { Primitive: { kind: "box" } }));
  issueCodes(() => bus.execute(create("e2", { Primitive: { kind: "torus" } })));
  assert.equal(bus.revision, 1);
  assert.ok(first.undoToken);
  bus.undo(first.undoToken);
  assert.equal(bus.snapshot().project.scenes[0]?.entities.length, 0);
});
