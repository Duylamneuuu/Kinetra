import assert from "node:assert/strict";
import test from "node:test";

import { parseProject } from "@kinetra/project-model";

import { CommandBus } from "../src/index.js";

// A document loaded from disk/MCP is JSON.parse'd, so "__proto__" is an own data property of
// `components` (project-model serialization already preserves it). Reading it back through
// queryEntities must return it as data, not re-prototype the result object.
// Written as raw JSON text: an object literal with "__proto__" would set the prototype instead.
const text =
  '{"schemaVersion":1,"projectId":"p","name":"Proto","scenes":[{"id":"s","name":"Main","entities":' +
  '[{"id":"e","name":"E","components":{"transform":{"x":1},"__proto__":{"top":1}}}]}]}';

test("queryEntities selectComponents returns a '__proto__' component as an own data property", () => {
  const project = parseProject(text);
  assert.deepEqual(Object.keys(project.scenes[0]!.entities[0]!.components).sort(), ["__proto__", "transform"]);

  const bus = new CommandBus(project);
  const result = bus.queryEntities({ selectComponents: ["__proto__", "transform"] });
  const components = result.items[0]!.entity.components;

  assert.deepEqual(Object.keys(components).sort(), ["__proto__", "transform"]);
  assert.equal(Object.getPrototypeOf(components), Object.prototype, "result must not be re-prototyped");
  assert.deepEqual(Object.getOwnPropertyDescriptor(components, "__proto__")?.value, { top: 1 });
});

test("queryEntities without selectComponents also keeps the '__proto__' component", () => {
  const bus = new CommandBus(parseProject(text));
  const components = bus.queryEntities().items[0]!.entity.components;
  assert.deepEqual(Object.getOwnPropertyDescriptor(components, "__proto__")?.value, { top: 1 });
});
