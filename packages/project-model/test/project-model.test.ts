import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectValidationError,
  migrateProject,
  parseProject,
  serializeProject,
  stableId,
  validateProject,
  type ProjectDocument,
} from "../src/index.js";

function fixture(): ProjectDocument {
  const rootId = stableId("entity", "root");
  const childId = stableId("entity", "child");

  return {
    schemaVersion: 1,
    projectId: stableId("project", "fixture"),
    name: "Fixture",
    scenes: [
      {
        id: stableId("scene", "main"),
        name: "Main",
        entities: [
          {
            id: childId,
            name: "Child",
            parentId: rootId,
            components: {
              Transform: { position: [1, 2, 3], scale: [1, 1, 1] },
            },
          },
          {
            id: rootId,
            name: "Root",
            components: {
              Transform: { position: [0, 0, 0] },
            },
          },
        ],
      },
    ],
  };
}

test("serializes deterministically and round-trips", () => {
  const project = fixture();
  const first = serializeProject(project);
  const second = serializeProject(parseProject(first));

  assert.equal(first, second);
  assert.deepEqual(parseProject(first), parseProject(second));
});

test("migrates schema v0 to v1", () => {
  const migrated = migrateProject({
    schemaVersion: 0,
    id: "project_legacy",
    name: "Legacy",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        objects: [
          {
            id: "entity_a",
            name: "A",
            components: { Transform: { position: [0, 0, 0] } },
          },
        ],
      },
    ],
  });

  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.projectId, "project_legacy");
  assert.equal(migrated.scenes[0]?.entities[0]?.id, "entity_a");
});

test("rejects duplicate entity ids and parent cycles", () => {
  const project = fixture();
  const scene = project.scenes[0];
  assert.ok(scene);

  const firstEntity = scene.entities[0];
  const secondEntity = scene.entities[1];
  assert.ok(firstEntity);
  assert.ok(secondEntity);

  secondEntity.id = firstEntity.id;
  secondEntity.parentId = firstEntity.id;
  firstEntity.parentId = secondEntity.id;

  const issues = validateProject(project);
  assert.ok(issues.some((issue) => issue.code === "entity.id.duplicate-in-project"));
  assert.ok(issues.some((issue) => issue.code === "entity.parent.cycle"));

  assert.throws(() => serializeProject(project), ProjectValidationError);
});
