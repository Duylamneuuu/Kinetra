import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError, type EngineCommand } from "../src/index.js";

const sceneId = stableId("scene", "regressions");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "regressions"),
    name: "Regressions",
    scenes: [{ id: sceneId, name: "Main", entities: [] }],
  };
}

function create(id: string, parentId?: string): EngineCommand {
  return {
    requestId: `create-${id}`,
    command: "entity.create",
    payload: {
      sceneId,
      entity: { id, name: id, ...(parentId ? { parentId } : {}), components: {} },
    },
  };
}

function reparent(entityId: string, parentId?: string): EngineCommand {
  return {
    requestId: `reparent-${entityId}`,
    command: "entity.reparent",
    payload: { entityId, ...(parentId ? { parentId } : {}) },
  };
}

function entityIds(bus: CommandBus): string[] {
  return bus.snapshot().project.scenes[0]!.entities.map((entity) => entity.id);
}

function assertCommandError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CommandError, `expected CommandError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.ok(error.remediation.length > 12);
    return true;
  });
}

test("reparenting under a descendant or itself is a structured PARENT_CYCLE error", () => {
  const bus = new CommandBus(project());
  const a = stableId("entity", "a");
  const b = stableId("entity", "b");
  const c = stableId("entity", "c");
  bus.executeTransaction([create(a), create(b, a), create(c, b)]);
  const before = bus.snapshot();

  assertCommandError(() => bus.execute(reparent(a, c)), "PARENT_CYCLE");
  assertCommandError(() => bus.execute(reparent(a, b)), "PARENT_CYCLE");
  assertCommandError(() => bus.execute(reparent(b, b)), "PARENT_CYCLE");

  assert.deepEqual(bus.snapshot(), before, "rejected reparent must not mutate or bump revision");

  // Legal moves still work: move c up to the root, then a under c.
  bus.execute(reparent(c));
  bus.execute(reparent(a, c));
  const byId = new Map(bus.snapshot().project.scenes[0]!.entities.map((e) => [e.id, e]));
  assert.equal(byId.get(a)?.parentId, c);
  assert.equal(byId.get(c)?.parentId, undefined);
});

test("undo is last-in first-out: an older token cannot discard newer changes", () => {
  const bus = new CommandBus(project());
  const first = stableId("entity", "first");
  const second = stableId("entity", "second");
  const t1 = bus.execute(create(first)).undoToken!;
  const t2 = bus.execute(create(second)).undoToken!;
  const before = bus.snapshot();

  assertCommandError(() => bus.undo(t1), "UNDO_CONFLICT");
  assert.deepEqual(bus.snapshot(), before, "rejected undo must not mutate or bump revision");

  bus.undo(t2);
  assert.deepEqual(entityIds(bus), [first]);
  bus.undo(t1);
  assert.deepEqual(entityIds(bus), []);
  assert.equal(bus.revision, 4);

  assertCommandError(() => bus.undo(t1), "INVALID_COMMAND");
  assertCommandError(() => bus.undo("undo_missing"), "INVALID_COMMAND");
});

test("undo still checks expectedProjectRevision before the token", () => {
  const bus = new CommandBus(project());
  const token = bus.execute(create(stableId("entity", "x"))).undoToken!;
  assertCommandError(() => bus.undo(token, 0), "STALE_REVISION");
  bus.undo(token, 1);
  assert.equal(bus.revision, 2);
});

test("dry runs and failed transactions do not create undo entries", () => {
  const bus = new CommandBus(project());
  const kept = stableId("entity", "kept");
  const token = bus.execute(create(kept)).undoToken!;

  bus.execute({ ...create(stableId("entity", "dry")), dryRun: true });
  assert.throws(() => bus.executeTransaction([create(stableId("entity", "ok")), create(kept)]));

  // The real change is still the top of the undo stack.
  bus.undo(token);
  assert.deepEqual(entityIds(bus), []);
});

for (const reserved of ["__proto__", "constructor", "prototype"]) {
  test(`component.patch rejects reserved component name ${reserved}`, () => {
    const bus = new CommandBus(project());
    const id = stableId("entity", "target");
    bus.execute(create(id));
    const before = bus.snapshot();

    const raw = JSON.parse(
      `{"requestId":"r","command":"component.patch","payload":{"entityId":"${id}","component":"${reserved}","patch":{"x":1}}}`,
    );
    assertCommandError(() => bus.executeUnknown(raw), "INVALID_COMMAND");
    assertCommandError(
      () =>
        bus.execute({
          requestId: "typed",
          command: "component.patch",
          payload: { entityId: id, component: reserved, patch: { x: 1 } },
        }),
      "INVALID_COMMAND",
    );
    assert.deepEqual(bus.snapshot(), before);
    const entity = bus.snapshot().project.scenes[0]!.entities[0]!;
    assert.equal(Object.getPrototypeOf(entity.components), Object.prototype);
  });
}

test("queryEntities normalizes non-finite and fractional paging values", () => {
  const bus = new CommandBus(project());
  bus.executeTransaction(
    Array.from({ length: 5 }, (_, index) => create(stableId("entity", `q${index}`))),
  );

  const nan = bus.queryEntities({ offset: Number.NaN, limit: Number.NaN });
  assert.equal(nan.offset, 0);
  assert.equal(nan.limit, 100);
  assert.equal(nan.items.length, 5);

  const fractional = bus.queryEntities({ offset: 1.7, limit: 2.9 });
  assert.equal(fractional.offset, 1);
  assert.equal(fractional.limit, 2);
  assert.equal(fractional.items.length, 2);
  assert.equal(fractional.nextOffset, 3);

  const infinite = bus.queryEntities({ offset: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY });
  assert.equal(infinite.offset, 0);
  assert.equal(infinite.limit, 100);

  const clamped = bus.queryEntities({ offset: -3, limit: 10_000 });
  assert.equal(clamped.offset, 0);
  assert.equal(clamped.limit, 500);
});
