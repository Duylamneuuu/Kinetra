import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  ProjectValidationError,
  migrateProject,
  parseProject,
  serializeProject,
  type ProjectDocument,
} from "../src/index.js";

function legacy(): Record<string, unknown> {
  return {
    schemaVersion: 0,
    id: "project_legacy",
    name: "Legacy",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        objects: [
          { id: "entity_root", name: "Root", components: { Transform: { position: [0, 0, 0] } } },
          { id: "entity_child", name: "Child", parent: "entity_root" },
        ],
      },
    ],
  };
}

function v1(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_v1",
    name: "V1",
    scenes: [{ id: "scene_main", name: "Main", entities: [{ id: "entity_a", name: "A", components: {} }] }],
  };
}

test("CURRENT_SCHEMA_VERSION matches the validator's accepted schema", () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 1);
  assert.equal(migrateProject(v1()).schemaVersion, CURRENT_SCHEMA_VERSION);
});

test("v0 migration maps parent links, defaults missing components and never mutates the input", () => {
  const input = legacy();
  const snapshot = structuredClone(input);
  const migrated = migrateProject(input);

  assert.deepEqual(input, snapshot, "migrateProject must not mutate its input");
  const entities = migrated.scenes[0]?.entities ?? [];
  assert.equal(entities.length, 2);
  assert.equal(entities[0]?.parentId, undefined);
  assert.ok(!("parentId" in (entities[0] ?? {})), "root must not carry an explicit parentId key");
  assert.equal(entities[1]?.parentId, "entity_root");
  assert.deepEqual(entities[1]?.components, {});

  // The migrated components are a copy, not an alias of the legacy document.
  const legacyTransform = (
    (input.scenes as Array<{ objects: Array<{ components: { Transform: { position: number[] } } }> }>)[0]?.objects[0]
  )?.components.Transform;
  const migratedTransform = entities[0]?.components.Transform as { position: number[] };
  assert.notEqual(migratedTransform, legacyTransform);
});

test("v0 migration tolerates a legacy document without scenes or objects", () => {
  const empty = migrateProject({ schemaVersion: 0, id: "project_empty", name: "Empty" });
  assert.deepEqual(empty.scenes, []);

  const noObjects = migrateProject({
    schemaVersion: 0,
    id: "project_no_objects",
    name: "No objects",
    scenes: [{ id: "scene_a", name: "A" }],
  });
  assert.deepEqual(noObjects.scenes[0]?.entities, []);
});

test("v0 migration rejects malformed legacy shapes with a descriptive error", () => {
  const cases: Array<[string, (doc: Record<string, unknown>) => void, RegExp]> = [
    ["scenes not an array", (doc) => void (doc.scenes = { 0: {} }), /scenes must be an array/],
    ["scene is null", (doc) => void (doc.scenes = [null]), /scenes\[0\] must be an object/],
    ["scene is an array", (doc) => void (doc.scenes = [[]]), /scenes\[0\] must be an object/],
    [
      "objects not an array",
      (doc) => void (doc.scenes = [{ id: "s", name: "S", objects: "nope" }]),
      /scenes\[0\]\.objects must be an array/,
    ],
    [
      "object is a primitive",
      (doc) => void (doc.scenes = [{ id: "s", name: "S", objects: [{ id: "e", name: "E" }, 7] }]),
      /scenes\[0\]\.objects\[1\] must be an object/,
    ],
  ];

  for (const [label, mutate, pattern] of cases) {
    const doc = legacy();
    mutate(doc);
    assert.throws(() => migrateProject(doc), pattern, label);
  }
});

test("a v0 document that migrates to something invalid is rejected by validation, not accepted", () => {
  const doc = legacy();
  (doc.scenes as Array<{ objects: Array<{ parent?: string }> }>)[0]!.objects[1]!.parent = "entity_missing";
  assert.throws(
    () => migrateProject(doc),
    (error: unknown) =>
      error instanceof ProjectValidationError && error.issues.some((issue) => issue.code === "entity.parent.missing"),
  );

  const noId = { schemaVersion: 0, name: "No id", scenes: [] };
  assert.throws(
    () => migrateProject(noId),
    (error: unknown) =>
      error instanceof ProjectValidationError && error.issues.some((issue) => issue.code === "project.id.empty"),
  );
});

test("migrateProject rejects non-documents and unusable schemaVersion values", () => {
  for (const bad of [null, undefined, 1, "text", [], { schemaVersion: "1" }, {}]) {
    assert.throws(() => migrateProject(bad), /missing a numeric schemaVersion/);
  }

  assert.throws(() => migrateProject({ ...v1(), schemaVersion: 2 }), /newer than supported schema 1/);
  assert.throws(() => migrateProject({ ...v1(), schemaVersion: Number.POSITIVE_INFINITY }), /newer than supported/);
  // Versions between registered migrations have no path forward.
  assert.throws(() => migrateProject({ ...v1(), schemaVersion: -1 }), /No migration registered from schema -1/);
  assert.throws(() => migrateProject({ ...v1(), schemaVersion: 0.5 }), /No migration registered from schema 0.5/);
  // NaN skips the migration loop and must still be refused by the validator.
  assert.throws(
    () => migrateProject({ ...v1(), schemaVersion: Number.NaN }),
    (error: unknown) =>
      error instanceof ProjectValidationError && error.issues.some((issue) => issue.code === "project.schema.unsupported"),
  );
});

test("migrateProject returns a copy: mutating the result never touches the input", () => {
  const input = v1();
  const output = migrateProject(input);
  assert.notEqual(output, input);
  output.scenes[0]!.entities[0]!.name = "Changed";
  assert.equal(input.scenes[0]!.entities[0]!.name, "A");
});

test("parseProject surfaces malformed JSON as SyntaxError and v0 text serializes at schema 1", () => {
  assert.throws(() => parseProject("{ not json"), SyntaxError);
  assert.throws(() => parseProject("null"), /missing a numeric schemaVersion/);

  const upgraded = serializeProject(parseProject(JSON.stringify(legacy())));
  const reparsed = JSON.parse(upgraded) as ProjectDocument;
  assert.equal(reparsed.schemaVersion, 1);
  assert.equal(reparsed.projectId, "project_legacy");
  // Serialization is idempotent once the document is current.
  assert.equal(serializeProject(parseProject(upgraded)), upgraded);
});
