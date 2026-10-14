import assert from "node:assert/strict";
import test from "node:test";

import { parseProject } from "@kinetra/project-model";

import { CommandBus, type EngineCommand } from "../src/index.js";

// A project loaded from disk/MCP is JSON.parse'd, so "__proto__" can be an own data property of a
// component's fields. component.unsetFields rebuilds the component from its remaining fields; a plain
// `remaining[key] = value` assignment would re-prototype the new object (object value) or silently drop
// the field (primitive value) instead of keeping it as data. Raw JSON text, because an object literal
// with "__proto__" would set the prototype instead of creating an own property.
function projectText(tag: string): string {
  return (
    '{"schemaVersion":1,"projectId":"p","name":"Proto","scenes":[{"id":"s","name":"Main","entities":' +
    `[{"id":"e","name":"E","components":{"Tag":${tag}}}]}]}`
  );
}

function unset(fields: string[]): EngineCommand {
  return {
    requestId: "unset-proto",
    command: "component.unsetFields",
    payload: { entityId: "e", component: "Tag", fields },
  };
}

function tagOf(bus: CommandBus): Record<string, unknown> {
  const tag = bus.queryEntities({ ids: ["e"] }).items[0]!.entity.components.Tag;
  assert.ok(typeof tag === "object" && tag !== null && !Array.isArray(tag));
  return tag as Record<string, unknown>;
}

test("unsetFields keeps an own '__proto__' object field as data", () => {
  const bus = new CommandBus(parseProject(projectText('{"a":1,"__proto__":{"top":1}}')));

  bus.execute(unset(["a"]));

  const tag = tagOf(bus);
  assert.equal(Object.getPrototypeOf(tag), Object.prototype, "component must not be re-prototyped");
  assert.deepEqual(Object.keys(tag), ["__proto__"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(tag, "__proto__")?.value, { top: 1 });
});

test("unsetFields keeps an own '__proto__' primitive field instead of dropping it", () => {
  const bus = new CommandBus(parseProject(projectText('{"a":1,"b":2,"__proto__":"keep"}')));

  bus.execute(unset(["a"]));

  const tag = tagOf(bus);
  assert.deepEqual(Object.keys(tag).sort(), ["__proto__", "b"]);
  assert.equal(Object.getOwnPropertyDescriptor(tag, "__proto__")?.value, "keep");
});

test("unsetFields can remove the '__proto__' field itself and keeps the rest", () => {
  const bus = new CommandBus(parseProject(projectText('{"a":1,"__proto__":{"top":1}}')));

  bus.execute(unset(["__proto__"]));

  const tag = tagOf(bus);
  assert.deepEqual(Object.keys(tag), ["a"]);
  assert.equal(tag.a, 1);
});

test("a dry-run unsetFields on a '__proto__' field leaves the committed component untouched", () => {
  const bus = new CommandBus(parseProject(projectText('{"a":1,"__proto__":{"top":1}}')));
  const before = bus.revision;

  const result = bus.execute({ ...unset(["a"]), dryRun: true });

  assert.equal(result.revision, before);
  assert.deepEqual(Object.keys(tagOf(bus)).sort(), ["__proto__", "a"]);
});
