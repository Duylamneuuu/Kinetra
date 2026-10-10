import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus, DEFAULT_MAX_UNDO_DEPTH } from "@kinetra/command-bus";
import type { ProjectDocument } from "@kinetra/project-model";

import { EditorSession } from "../src/index.js";

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_editor_history",
    name: "Editor history fixture",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [{ id: "root", name: "Root", components: { Stats: { hp: 0 } } }],
      },
    ],
  };
}

function hp(bus: CommandBus): unknown {
  const entity = bus.snapshot().project.scenes[0]!.entities[0]!;
  return (entity.components.Stats as { hp: number }).hp;
}

test("the editor remembers no more edits than the bus can still undo", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  const edits = DEFAULT_MAX_UNDO_DEPTH + 50;
  for (let index = 1; index <= edits; index += 1) {
    editor.patchComponent("root", "Stats", { hp: index });
  }

  let undone = 0;
  while (editor.canUndo) {
    editor.undo();
    undone += 1;
    assert.ok(undone <= edits, "undo must terminate");
  }
  // Every undo the editor offered really worked; none of them hit an expired bus token.
  assert.equal(undone, DEFAULT_MAX_UNDO_DEPTH);
  assert.equal(hp(bus), 50);
});

test("maxHistory lets the editor follow a bus built with a different undo depth", () => {
  const bus = new CommandBus(fixture(), 0, { maxUndoDepth: 3 });
  const editor = new EditorSession(bus, { maxHistory: 3 });
  for (let index = 1; index <= 10; index += 1) {
    editor.patchComponent("root", "Stats", { hp: index });
  }
  let undone = 0;
  while (editor.canUndo) {
    editor.undo();
    undone += 1;
  }
  assert.equal(undone, 3);
  assert.equal(hp(bus), 7);
});

test("maxHistory must be a positive integer or Infinity", () => {
  const bus = new CommandBus(fixture());
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new EditorSession(bus, { maxHistory: bad }), RangeError, String(bad));
  }
  assert.doesNotThrow(() => new EditorSession(bus, { maxHistory: Infinity }));
  assert.doesNotThrow(() => new EditorSession(bus, { maxHistory: 1 }));
});
