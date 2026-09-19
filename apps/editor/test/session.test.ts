import assert from "node:assert/strict";
import test from "node:test";

import {
  stableId,
  type ProjectDocument,
} from "@kinetra/project-model";

import { EditorSession } from "../src/session.js";

const sceneId = stableId("scene", "editor-test");
const entityId = stableId("entity", "editor-box");

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "editor-test"),
    name: "Editor test",
    scenes: [
      {
        id: sceneId,
        name: "Main",
        entities: [
          {
            id: entityId,
            name: "Box",
            components: {
              Transform: {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
            },
          },
        ],
      },
    ],
  };
}

test("editor transform mutation is observable through CommandBus history", async () => {
  const persisted: ProjectDocument[] = [];
  const session = new EditorSession(fixture(), {
    persist: async (project) => {
      persisted.push(structuredClone(project));
    },
  });

  await session.patchTransform(entityId, {
    position: [4, 2, 1],
    rotation: [0, 0.5, 0],
    scale: [1, 1, 1],
  });

  assert.equal(session.bus.revision, 1);
  assert.equal(persisted.length, 1);

  const event = session.events()[0];
  assert.equal(event?.commands[0]?.command, "component.patch");
  assert.equal(event?.changes[0]?.resource, "component");

  const transform =
    session.snapshot().project.scenes[0]?.entities[0]?.components.Transform;

  assert.deepEqual(transform, {
    position: [4, 2, 1],
    rotation: [0, 0.5, 0],
    scale: [1, 1, 1],
  });
});

test("editor box creation and deletion use semantic entity commands", async () => {
  const session = new EditorSession(fixture());

  await session.createBox(sceneId);
  assert.equal(
    session.events().at(-1)?.commands[0]?.command,
    "entity.create",
  );

  const created = session
    .snapshot()
    .project.scenes[0]?.entities.find(
      (entity) => entity.id !== entityId,
    );

  assert.ok(created);

  await session.deleteEntity(created.id);
  assert.equal(
    session.events().at(-1)?.commands[0]?.command,
    "entity.delete",
  );
});
