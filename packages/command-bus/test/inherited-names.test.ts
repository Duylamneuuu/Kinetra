import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { CommandBus } from "../src/index.js";

const sceneId = stableId("scene", "inherited");
const withTransform = stableId("entity", "with-transform");
const bare = stableId("entity", "bare");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "inherited"),
    name: "Inherited names",
    scenes: [
      {
        id: sceneId,
        name: "Main",
        entities: [
          { id: withTransform, name: "With transform", components: { transform: { x: 1 } } },
          { id: bare, name: "Bare", components: {} },
        ],
      },
    ],
  };
}

// Names that exist on Object.prototype but are never stored as component data.
const INHERITED_NAMES = ["toString", "valueOf", "hasOwnProperty", "constructor", "__proto__"];

test("queryEntities component filter ignores names inherited from Object.prototype", () => {
  const bus = new CommandBus(project());
  for (const name of INHERITED_NAMES) {
    const result = bus.queryEntities({ component: name });
    assert.equal(result.total, 0, `component filter "${name}" must not match any entity`);
    assert.deepEqual(result.items, []);
  }
  assert.equal(bus.queryEntities({ component: "transform" }).total, 1);
});

test("queryEntities selectComponents never reads or writes inherited members", () => {
  const bus = new CommandBus(project());
  for (const name of INHERITED_NAMES) {
    const result = bus.queryEntities({ selectComponents: [name, "transform"] });
    assert.equal(result.total, 2);
    const first = result.items[0]!.entity;
    assert.deepEqual(Object.keys(first.components), ["transform"], `select "${name}"`);
    assert.equal(Object.getPrototypeOf(first.components), Object.prototype);
    assert.deepEqual(Object.keys(result.items[1]!.entity.components), []);
  }
});

test("component.patch on a not-yet-stored inherited name creates it instead of failing with COMPONENT_NOT_OBJECT", () => {
  const bus = new CommandBus(project());
  const result = bus.execute({
    requestId: "patch-valueOf",
    command: "component.patch",
    payload: { entityId: bare, component: "valueOf", patch: { k: 1 } },
  });
  assert.equal(result.ok, true);
  const stored = bus.snapshot().project.scenes[0]!.entities[1]!.components;
  assert.deepEqual(Object.keys(stored), ["valueOf"]);
  assert.deepEqual(stored["valueOf"], { k: 1 });
});
