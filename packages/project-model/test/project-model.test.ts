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

test("parent errors name bounded entity choices and the cycle path", () => {
  const sceneId = "scene_main";
  const project = (entities: ProjectDocument["scenes"][number]["entities"]): ProjectDocument => ({
    schemaVersion: 1,
    projectId: "project_parents",
    name: "Parents",
    scenes: [{ id: sceneId, name: "Main", entities }],
  });

  const missing = validateProject(
    project([
      { id: "entity_child", name: "Child", parentId: "entity_missing", components: {} },
      { id: "entity_root", name: "Root", components: {} },
    ]),
  ).find((issue) => issue.code === "entity.parent.missing");
  assert.equal(
    missing?.message,
    'Parent entity "entity_missing" does not exist in scene "scene_main". Available entities: entity_child, entity_root.',
  );

  const cycleIssues = validateProject(
    project([
      { id: "entity_a", name: "A", parentId: "entity_b", components: {} },
      { id: "entity_b", name: "B", parentId: "entity_a", components: {} },
    ]),
  ).filter((issue) => issue.code === "entity.parent.cycle");
  assert.equal(cycleIssues.length, 1);
  assert.equal(cycleIssues[0]?.message, "Parent cycle detected: entity_a -> entity_b -> entity_a.");

  const ids = Array.from({ length: 13 }, (_, index) => `entity-${String(index).padStart(2, "0")}`);
  const longCycle = validateProject(
    project(
      ids.map((id, index) => ({
        id,
        name: id,
        parentId: ids[(index + 1) % ids.length] ?? id,
        components: {},
      })),
    ),
  ).find((issue) => issue.code === "entity.parent.cycle");
  assert.equal(
    longCycle?.message,
    `Parent cycle detected: ${ids.slice(0, 12).join(" -> ")}, and 1 more, returning to ${ids[0]}.`,
  );
  assert.equal(longCycle?.message.includes("entity-12"), false);

  const capped = validateProject(
    project([
      ...ids.map((id) => ({ id, name: id, components: {} })),
      { id: "entity_orphan", name: "Orphan", parentId: "entity_missing", components: {} },
    ]),
  ).find((issue) => issue.code === "entity.parent.missing");
  assert.match(
    capped?.message ?? "",
    /Available entities: entity-00, entity-01, entity-02, entity-03, entity-04, entity-05, entity-06, entity-07, entity-08, entity-09, entity-10, entity-11, and 2 more\./,
  );
  assert.equal(capped?.message.includes("entity-12"), false);
  assert.equal(capped?.message.includes("entity_orphan"), false);
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
