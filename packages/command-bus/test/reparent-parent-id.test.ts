import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, CommandError } from "../src/index.js";

const sceneId = stableId("scene", "rp");
const rootId = stableId("entity", "rp-root");
const kidId = stableId("entity", "rp-kid");

function seeded(): CommandBus {
  const project: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "rp"),
    name: "Reparent parentId",
    scenes: [
      {
        id: sceneId,
        name: "S",
        entities: [
          { id: rootId, name: "Root", components: {} },
          { id: kidId, name: "Kid", parentId: rootId, components: {} },
        ],
      },
    ],
  };
  return new CommandBus(project);
}

function reparent(payload: Record<string, unknown>): unknown {
  return { requestId: "rp", command: "entity.reparent", payload };
}

function parentOfKid(bus: CommandBus): string | undefined {
  return bus.snapshot().project.scenes[0]?.entities.find((entity) => entity.id === kidId)?.parentId;
}

test('reparent with parentId "" is rejected instead of silently detaching the entity', () => {
  const bus = seeded();
  const revision = bus.snapshot();
  const events = bus.eventLog().length;

  let thrown: unknown;
  assert.throws(() => bus.executeUnknown(reparent({ entityId: kidId, parentId: "" })), (error) => {
    thrown = error;
    return true;
  });
  assert.ok(thrown instanceof CommandError);
  assert.equal(thrown.code, "INVALID_COMMAND");
  assert.ok(thrown.remediation.length > 0);

  assert.equal(parentOfKid(bus), rootId, "the hierarchy is untouched by the rejected command");
  assert.deepEqual(bus.snapshot(), revision);
  assert.equal(bus.eventLog().length, events, "a rejected command records no event");
});

test("reparent rejects non-string parentId values and still detaches when parentId is omitted", () => {
  const bus = seeded();
  for (const bad of [null, 0, false, {}, []]) {
    assert.throws(
      () => bus.executeUnknown(reparent({ entityId: kidId, parentId: bad })),
      (error) => error instanceof CommandError && error.code === "INVALID_COMMAND",
      `parentId ${JSON.stringify(bad)}`,
    );
    assert.equal(parentOfKid(bus), rootId);
  }

  bus.executeUnknown(reparent({ entityId: kidId }));
  assert.equal(parentOfKid(bus), undefined, "omitting parentId is the way to detach");
  assert.ok(!("parentId" in (bus.snapshot().project.scenes[0]?.entities[1] ?? {})), "no dangling parentId key");

  bus.executeUnknown(reparent({ entityId: kidId, parentId: rootId }));
  assert.equal(parentOfKid(bus), rootId);
});

test("entity.create with an empty parentId is a structured INVALID_COMMAND and leaves no entity behind", () => {
  const bus = seeded();
  const before = bus.snapshot();
  assert.throws(
    () =>
      bus.executeUnknown({
        requestId: "c",
        command: "entity.create",
        payload: {
          sceneId,
          entity: { id: stableId("entity", "rp-new"), name: "New", parentId: "", components: {} },
        },
      }),
    (error) => error instanceof CommandError && error.code === "INVALID_COMMAND",
  );
  assert.deepEqual(bus.snapshot(), before);
});
