import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus, CommandError } from "@kinetra/command-bus";
import type { ProjectDocument } from "@kinetra/project-model";

import { EditorSession } from "../src/index.js";

/**
 * Seeded model-based fuzz of the editor session against a real CommandBus. The reference model is
 * deliberately dumb: a stack of "project before / project after" pairs for the editor's own edits.
 * Invariants checked after every operation:
 * - every failure is a structured CommandError and leaves the project and revision untouched;
 * - a successful edit clears redo; undo restores exactly the project from before that edit; redo
 *   restores exactly the project from after it;
 * - canUndo / canRedo agree with the model;
 * - the selection only ever lists entities that exist.
 */
function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_fuzz",
    name: "Fuzz fixture",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [
          { id: "e0", name: "E0", components: { Stats: { hp: 10, tags: ["a", "b"], pos: { x: 0, y: 0 } } } },
          { id: "e1", name: "E1", parentId: "e0", components: {} },
        ],
      },
    ],
  };
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface Step {
  before: ProjectDocument;
  after: ProjectDocument;
}

test("fuzz: random editor operations keep undo/redo, failures and selection consistent with the bus", () => {
  for (let round = 0; round < 60; round += 1) {
    const random = makeRandom(0x9e3779b1 ^ (round * 7919));
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const bus = new CommandBus(fixture());
    const editor = new EditorSession(bus);
    const project = (): ProjectDocument => structuredClone(bus.snapshot().project);
    const undoModel: Step[] = [];
    let redoModel: Step[] = [];
    let nextId = 2;

    const entityIds = (): string[] => bus.snapshot().project.scenes[0]!.entities.map((entity) => entity.id);
    const someId = (): string => (random() < 0.1 ? "ghost" : pick(entityIds().length > 0 ? entityIds() : ["ghost"]));

    for (let step = 0; step < 40; step += 1) {
      const before = project();
      const revisionBefore = bus.revision;
      const roll = random();
      const label = `round ${round} step ${step} roll ${roll.toFixed(3)}`;
      let kind: "edit" | "undo" | "redo" | "select";
      let run: () => unknown;

      if (roll < 0.2) {
        kind = "edit";
        run = () =>
          editor.createEntity({
            sceneId: "scene_main",
            id: random() < 0.1 ? "e0" : `n${nextId++}`,
            name: "New",
            ...(random() < 0.6 ? { parentId: someId() } : {}),
          });
      } else if (roll < 0.35) {
        kind = "edit";
        run = () => editor.patchComponent(someId(), "Stats", { hp: Math.floor(random() * 100) });
      } else if (roll < 0.5) {
        kind = "edit";
        const path = pick(["hp", "pos.x", "tags.1", "tags.9", "hp.deep", "pos.__proto__", "", "tags.0"]);
        run = () => editor.setProperty(someId(), "Stats", path, Math.floor(random() * 10));
      } else if (roll < 0.62) {
        kind = "edit";
        run = () => editor.reparent(someId(), random() < 0.2 ? undefined : someId());
      } else if (roll < 0.7) {
        kind = "edit";
        run = () => editor.deleteEntity(someId(), random() < 0.5);
      } else if (roll < 0.82) {
        kind = "undo";
        run = () => editor.undo();
      } else if (roll < 0.92) {
        kind = "redo";
        run = () => editor.redo();
      } else {
        kind = "select";
        const ids = Array.from({ length: Math.floor(random() * 4) }, () => someId());
        run = () => editor.select(ids);
      }

      let failed = false;
      try {
        run();
      } catch (error) {
        failed = true;
        assert.ok(error instanceof CommandError, `${label}: expected CommandError, got ${String(error)}`);
      }

      if (failed) {
        assert.deepEqual(project(), before, `${label}: a failed ${kind} must not change the project`);
        assert.equal(bus.revision, revisionBefore, `${label}: a failed ${kind} must not bump the revision`);
      } else if (kind === "edit") {
        undoModel.push({ before, after: project() });
        redoModel = [];
      } else if (kind === "undo") {
        const entry = undoModel.pop();
        assert.ok(entry, `${label}: undo succeeded with an empty model`);
        assert.deepEqual(project(), entry.before, `${label}: undo restores the project from before the edit`);
        redoModel.push(entry);
      } else if (kind === "redo") {
        const entry = redoModel.pop();
        assert.ok(entry, `${label}: redo succeeded with an empty model`);
        assert.deepEqual(project(), entry.after, `${label}: redo restores the project from after the edit`);
        undoModel.push(entry);
      }

      assert.equal(editor.canUndo, undoModel.length > 0, `${label}: canUndo`);
      assert.equal(editor.canRedo, redoModel.length > 0, `${label}: canRedo`);
      const alive = new Set(entityIds());
      for (const id of editor.selection) {
        assert.ok(alive.has(id), `${label}: selection lists a missing entity "${id}"`);
      }
    }

    // Unwinding everything the editor did lands back on the starting project.
    while (editor.canUndo) editor.undo();
    assert.deepEqual(project(), fixture(), `round ${round}: full undo returns to the fixture`);
  }
});
