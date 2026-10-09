import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectValidationError,
  migrateProject,
  parseProject,
  serializeProject,
  validateProject,
  type ProjectDocument,
} from "../src/index.js";

function issueCodes(error: unknown): string[] {
  assert.ok(error instanceof ProjectValidationError, `expected ProjectValidationError, got ${String(error)}`);
  return error.issues.map((issue) => issue.code);
}

test("parseProject rejects structurally malformed v1 documents with structured issues instead of TypeErrors", () => {
  const cases: Array<[string, string]> = [
    ['{"schemaVersion":1,"projectId":"p","name":"P"}', "project.scenes.invalid"],
    ['{"schemaVersion":1,"projectId":"p","name":"P","scenes":{}}', "project.scenes.invalid"],
    ['{"schemaVersion":1,"projectId":"p","name":"P","scenes":[null]}', "scene.invalid"],
    ['{"schemaVersion":1,"projectId":"p","name":"P","scenes":[{"id":"s","name":"S"}]}', "scene.entities.invalid"],
    ['{"schemaVersion":1,"projectId":"p","name":"P","scenes":[{"id":"s","name":"S","entities":[7]}]}', "entity.invalid"],
    ['{"schemaVersion":1,"projectId":"p","name":"P","scenes":[],"metadata":[1,2]}', "project.metadata.not-json"],
  ];

  for (const [text, code] of cases) {
    let caught: unknown;
    try {
      parseProject(text);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `expected ${text} to be rejected`);
    assert.ok(issueCodes(caught).includes(code), `expected issue ${code} for ${text}, got ${issueCodes(caught).join(",")}`);
  }
});

test("validateProject rejects non-string ids and names instead of accepting truthy values", () => {
  const issues = validateProject({
    schemaVersion: 1,
    projectId: 42,
    name: "P",
    scenes: [{ id: "s", name: "S", entities: [{ id: { nested: true }, name: "E", components: {} }] }],
  } as unknown as ProjectDocument);
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("project.id.empty"), codes.join(","));
  assert.ok(codes.includes("entity.id.empty"), codes.join(","));
});

test("cyclic component data is reported as a structured issue, not a stack overflow", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const issues = validateProject({
    schemaVersion: 1,
    projectId: "p",
    name: "P",
    scenes: [{ id: "s", name: "S", entities: [{ id: "e", name: "E", components: { Bad: cyclic } }] }],
  } as unknown as ProjectDocument);
  assert.deepEqual(issues.map((issue) => issue.code), ["component.value.not-json"]);
});

test("non-plain objects and sparse arrays are not accepted as JSON component data", () => {
  const sparse: unknown[] = [];
  sparse[2] = 1;
  for (const bad of [new Map([["a", 1]]), new Date(0), sparse, { nested: new Set([1]) }]) {
    const issues = validateProject({
      schemaVersion: 1,
      projectId: "p",
      name: "P",
      scenes: [{ id: "s", name: "S", entities: [{ id: "e", name: "E", components: { Bad: bad } }] }],
    } as unknown as ProjectDocument);
    assert.deepEqual(issues.map((issue) => issue.code), ["component.value.not-json"], `expected rejection for ${String(bad)}`);
  }
});

test("serializeProject orders scenes, entities and keys by code unit, independent of locale", () => {
  const project: ProjectDocument = {
    schemaVersion: 1,
    projectId: "p",
    name: "P",
    scenes: [
      {
        id: "scene",
        name: "Scene",
        entities: [
          { id: "b", name: "b", components: {} },
          { id: "B", name: "B", components: {} },
          { id: "a", name: "a", components: {} },
          { id: "_z", name: "_z", components: {} },
        ],
      },
    ],
  };
  const parsed = JSON.parse(serializeProject(project)) as ProjectDocument;
  assert.deepEqual(parsed.scenes[0]!.entities.map((entity) => entity.id), ["B", "_z", "a", "b"]);
});

test("validateProject requires a non-empty string scene name, matching the scene.create command contract", () => {
  const withSceneName = (name: unknown): ProjectDocument =>
    ({ schemaVersion: 1, projectId: "p", name: "P", scenes: [{ id: "s", name, entities: [] }] }) as unknown as ProjectDocument;

  for (const bad of [undefined, null, "", 0, 7, true, {}, ["S"]]) {
    const issues = validateProject(withSceneName(bad));
    assert.deepEqual(
      issues.map((issue) => [issue.path, issue.code]),
      [["scenes[0].name", "scene.name.empty"]],
      `name=${JSON.stringify(bad)}`,
    );
  }
  assert.deepEqual(validateProject(withSceneName("Level 1")), []);
});

test("a missing scene name in stored JSON or a v0 migration is a structured issue", () => {
  assert.throws(
    () => parseProject('{"schemaVersion":1,"projectId":"p","name":"P","scenes":[{"id":"s","entities":[]}]}'),
    (error: unknown) => issueCodes(error).includes("scene.name.empty"),
  );
  assert.throws(
    () => migrateProject({ schemaVersion: 0, id: "p", name: "P", scenes: [{ id: "s", objects: [] }] }),
    (error: unknown) => issueCodes(error).includes("scene.name.empty"),
  );
});

test("migrateProject reports a v0 document with malformed scenes as a structured error", () => {
  assert.throws(
    () => migrateProject({ schemaVersion: 0, id: "p", name: "P", scenes: [{ id: "s", name: "S", objects: "nope" }] }),
    (error: unknown) => error instanceof Error && /v0/.test(error.message),
  );
});
