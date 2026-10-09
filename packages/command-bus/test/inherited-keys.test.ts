import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus, type EngineCommand } from "../src/index.js";

const sceneId = stableId("scene", "inherited");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "inherited"),
    name: "Inherited keys",
    scenes: [
      {
        id: sceneId,
        name: "Main",
        entities: [
          { id: stableId("entity", "a"), name: "A", components: { transform: { x: 1 } } },
          { id: stableId("entity", "b"), name: "B", components: {} },
        ],
      },
    ],
  };
}

const INHERITED_NAMES = ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"];

test("queryEntities component filter ignores keys inherited from Object.prototype", () => {
  const bus = new CommandBus(project());
  for (const name of INHERITED_NAMES) {
    const result = bus.queryEntities({ component: name });
    assert.equal(result.total, 0, `component filter "${name}" must not match every entity`);
  }
  assert.equal(bus.queryEntities({ component: "transform" }).total, 1);
});

test("queryEntities selectComponents never throws or leaks inherited members", () => {
  const bus = new CommandBus(project());
  for (const name of INHERITED_NAMES) {
    const result = bus.queryEntities({ selectComponents: [name, "transform"] });
    assert.equal(result.total, 2);
    const first = result.items[0]!.entity;
    assert.deepEqual(Object.keys(first.components), ["transform"], `select "${name}"`);
    assert.equal(Object.getPrototypeOf(first.components), Object.prototype);
  }
});

test("component.patch can create a component whose name shadows an Object.prototype member", () => {
  const bus = new CommandBus(project());
  const command: EngineCommand = {
    requestId: "patch-valueof",
    command: "component.patch",
    payload: { entityId: stableId("entity", "b"), component: "valueOf", patch: { n: 1 } },
  };
  bus.execute(command);
  const entity = bus.snapshot().project.scenes[0]!.entities[1]!;
  assert.deepEqual(entity.components["valueOf"], { n: 1 });
});
