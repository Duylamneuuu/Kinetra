import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, type EngineCommand } from "../src/index.js";

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "initial-revision"),
    name: "Initial revision",
    scenes: [
      {
        id: stableId("scene", "initial-revision"),
        name: "Main",
        entities: [{ id: "e1", name: "E1", components: { Transform: { x: 0 } } }],
      },
    ],
  };
}

const patch: EngineCommand = {
  requestId: "r1",
  command: "component.patch",
  payload: { entityId: "e1", component: "Transform", patch: { x: 1 } },
};

test("constructor rejects an initialRevision that is not a non-negative safe integer", () => {
  // NaN/Infinity/fractions/strings used to be accepted: revision became NaN, every
  // proposedRevision NaN, and expectedProjectRevision could never match again.
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, "3" as unknown as number]) {
    assert.throws(
      () => new CommandBus(project(), bad),
      RangeError,
      `expected initialRevision ${String(bad)} to be rejected`,
    );
  }
});

test("a resumed bus keeps counting from a valid initialRevision", () => {
  const bus = new CommandBus(project(), 41);
  assert.equal(bus.revision, 41);
  const result = bus.execute({ ...patch, expectedProjectRevision: 41 });
  assert.equal(result.revision, 42);
  assert.equal(new CommandBus(project(), 0).revision, 0);
});
