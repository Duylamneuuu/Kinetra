import assert from "node:assert/strict";
import test from "node:test";

import { validateProject, type ProjectDocument } from "../src/index.js";

function project(entities: ProjectDocument["scenes"][number]["entities"]): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "p",
    name: "Scale",
    scenes: [{ id: "s", name: "S", entities }],
  } as ProjectDocument;
}

test("validateProject reports absurdly deep component JSON as an issue instead of overflowing the stack", () => {
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let i = 0; i < 20_000; i += 1) {
    const next: Record<string, unknown> = {};
    cursor.child = next;
    cursor = next;
  }

  const issues = validateProject(
    project([{ id: "e", name: "E", components: { data: deep as never } }]),
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["component.value.not-json"],
  );
});

test("reasonably nested component JSON is still accepted", () => {
  let value: unknown = 1;
  for (let i = 0; i < 100; i += 1) value = { child: value };
  assert.deepEqual(validateProject(project([{ id: "e", name: "E", components: { data: value as never } }])), []);
});

test("validateProject stays near-linear for a long parent chain", () => {
  const count = 20_000;
  const entities = Array.from({ length: count }, (_, index) => ({
    id: `e${index}`,
    name: "E",
    ...(index > 0 ? { parentId: `e${index - 1}` } : {}),
    components: {},
  }));

  const started = Date.now();
  const issues = validateProject(project(entities));
  const elapsed = Date.now() - started;

  assert.deepEqual(issues, []);
  assert.ok(elapsed < 5_000, `validation of ${count} chained entities took ${elapsed}ms`);
});

test("parent cycle detection flags every entity whose chain never ends, and only those", () => {
  const issues = validateProject(
    project([
      { id: "a", name: "A", parentId: "b", components: {} },
      { id: "b", name: "B", parentId: "a", components: {} },
      { id: "c", name: "C", parentId: "a", components: {} },
      { id: "self", name: "Self", parentId: "self", components: {} },
      { id: "root", name: "Root", components: {} },
      { id: "leaf", name: "Leaf", parentId: "root", components: {} },
    ]),
  );
  const cyclic = issues.filter((issue) => issue.code === "entity.parent.cycle").map((issue) => issue.path);
  assert.deepEqual(cyclic.sort(), [
    "scenes[s].entities[a].parentId",
    "scenes[s].entities[b].parentId",
    "scenes[s].entities[c].parentId",
    "scenes[s].entities[self].parentId",
  ]);
  assert.equal(issues.length, 4);
});
