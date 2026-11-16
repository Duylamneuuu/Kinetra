import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { validateProject, type ProjectDocument } from "../src/index.js";

function foreign<T>(source: string): T {
  return vm.runInNewContext(`(${source})`) as T;
}

function projectWith(components: unknown, metadata?: unknown): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "p",
    name: "P",
    ...(metadata === undefined ? {} : { metadata }),
    scenes: [{ id: "s", name: "S", entities: [{ id: "e", name: "E", components }] }],
  } as unknown as ProjectDocument;
}

function codes(project: ProjectDocument): string[] {
  return validateProject(project).map((issue) => issue.code);
}

test("entity components and metadata built in another realm are accepted as plain objects", () => {
  const components = foreign<unknown>(`({ Transform: { position: [0, 0, 0] } })`);
  const metadata = foreign<unknown>(`({ author: "x", tags: ["a"], nested: { n: 1 } })`);
  assert.deepEqual(codes(projectWith(components, metadata)), []);
});

test("a whole project document parsed in another realm validates cleanly", () => {
  const doc = foreign<ProjectDocument>(
    `({ schemaVersion: 1, projectId: "p", name: "P", scenes: [{ id: "s", name: "S", entities: [{ id: "e", name: "E", components: { Transform: { position: [0, 0, 0] } } }] }] })`,
  );
  assert.deepEqual(codes(doc), []);
});

test("non-plain values from another realm or with odd prototype chains are still rejected", () => {
  class Bag {
    Transform = { position: [0, 0, 0] };
  }
  for (const [label, value] of [
    ["foreign Map", foreign<unknown>("new Map()")],
    ["foreign Date", foreign<unknown>("new Date(0)")],
    ["foreign Set", foreign<unknown>("new Set()")],
    ["foreign class instance", foreign<unknown>(`new (class Bag { constructor() { this.Transform = {}; } })()`)],
    ["local class instance", new Bag()],
    ["Object.create(Object.create(null))", Object.create(Object.create(null))],
    ["Object.create(plain)", Object.create({ Transform: {} })],
  ] as const) {
    assert.ok(codes(projectWith(value)).includes("entity.components.invalid"), `${label} should be rejected as components`);
  }
});

test("foreign metadata containing a non-plain nested value is still rejected", () => {
  const metadata = foreign<unknown>(`({ when: new Date(0) })`);
  assert.ok(codes(projectWith({}, metadata)).length > 0);
});
