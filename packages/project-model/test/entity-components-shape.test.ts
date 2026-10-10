import assert from "node:assert/strict";
import test from "node:test";

import { parseProject, serializeProject, validateProject, type ProjectDocument } from "../src/index.js";

function projectWith(components: unknown): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "p",
    name: "P",
    scenes: [{ id: "s", name: "S", entities: [{ id: "e", name: "E", components }] }],
  } as unknown as ProjectDocument;
}

function codes(components: unknown): string[] {
  return validateProject(projectWith(components)).map((issue) => issue.code);
}

test("entity components must be a plain object: Map, Date, Set and class instances are rejected", () => {
  class Bag {
    Transform = { position: [0, 0, 0] };
  }
  for (const [label, value] of [
    ["Map", new Map([["Transform", {}]])],
    ["Date", new Date(0)],
    ["Set", new Set(["Transform"])],
    ["class instance", new Bag()],
  ] as const) {
    assert.ok(codes(value).includes("entity.components.invalid"), `${label} should be rejected`);
  }
});

test("entity components reject arrays, null, undefined and primitives", () => {
  for (const value of [[], [{ Transform: {} }], null, undefined, "Transform", 7, true]) {
    assert.ok(codes(value).includes("entity.components.invalid"), `${String(value)} should be rejected`);
  }
});

test("entity components accept a plain object, an empty object and a null-prototype object", () => {
  assert.deepEqual(codes({}), []);
  assert.deepEqual(codes({ Tag: { value: "x" } }), []);
  const bare = Object.create(null) as Record<string, unknown>;
  bare.Tag = { value: "x" };
  assert.deepEqual(codes(bare), []);
});

test("a Map smuggled into components no longer serializes to an empty object silently", () => {
  assert.throws(() => serializeProject(projectWith(new Map([["Transform", { position: [0, 0, 0] }]]))), /validation failed/i);
});

test("parseProject rejects a non-object components value from JSON text with a structured issue", () => {
  const text = JSON.stringify(projectWith([]));
  assert.throws(
    () => parseProject(text),
    (error: unknown) => {
      const issues = (error as { issues?: Array<{ code: string; path: string }> }).issues ?? [];
      return issues.some((issue) => issue.code === "entity.components.invalid" && issue.path.endsWith(".components"));
    },
  );
});

test("an empty component name is reported while other components still validate", () => {
  const found = validateProject(projectWith({ "": { a: 1 }, Tag: { b: 2 } })).map((issue) => issue.code);
  assert.ok(found.includes("component.name.empty"), found.join(","));
});
