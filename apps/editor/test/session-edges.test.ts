import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus, CommandError } from "@kinetra/command-bus";
import type { ProjectDocument } from "@kinetra/project-model";

import { EditorSession } from "../src/index.js";

function fixture(entityCount = 0): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_editor_edges",
    name: "Editor edges fixture",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [
          { id: "root", name: "Root", components: { Stats: { hp: 10 } } },
          ...Array.from({ length: entityCount }, (_, index) => ({
            id: `bulk_${index}`,
            name: `Bulk ${index}`,
            components: {},
          })),
        ],
      },
      { id: "scene_two", name: "Two", entities: [{ id: "other", name: "Other", components: {} }] },
    ],
  };
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected the call to throw");
}

test("selection works at the 500 limit and across scenes, in selection order", () => {
  const bus = new CommandBus(fixture(600));
  const editor = new EditorSession(bus);
  const ids = Array.from({ length: 500 }, (_, index) => `bulk_${599 - index}`);
  editor.select(ids);
  assert.equal(editor.selection.length, 500);
  assert.deepEqual(editor.selection.slice(0, 3), ["bulk_599", "bulk_598", "bulk_597"]);

  editor.select(["other", "root"]);
  assert.deepEqual(editor.selection, ["other", "root"], "entities of different scenes can be selected together");

  editor.select([]);
  assert.deepEqual(editor.selection, [], "selecting nothing clears the selection");
});

test("the selection getter returns a copy: mutating it cannot change the editor", () => {
  const editor = new EditorSession(new CommandBus(fixture()));
  editor.select(["root", "other"]);
  (editor.selection as string[]).push("ghost");
  assert.deepEqual(editor.selection, ["root", "other"]);
});

test("a rejected select (unknown id or over the limit) keeps the previous selection", () => {
  const editor = new EditorSession(new CommandBus(fixture()));
  editor.select(["root"]);
  assert.equal(codeOf(() => editor.select(["other", "ghost"])), "ENTITY_NOT_FOUND");
  assert.equal(
    codeOf(() => editor.select(Array.from({ length: 501 }, (_, index) => `x${index}`))),
    "INVALID_COMMAND",
  );
  assert.deepEqual(editor.selection, ["root"]);
});

test("duplicates do not count against the selection limit", () => {
  const editor = new EditorSession(new CommandBus(fixture()));
  editor.select(Array.from({ length: 1000 }, () => "root"));
  assert.deepEqual(editor.selection, ["root"]);
});

test("a custom requestIdPrefix is stamped on every command, including redo", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus, { requestIdPrefix: "panel" });
  editor.patchComponent("root", "Stats", { hp: 1 });
  editor.undo();
  editor.redo();
  const ids = bus.eventLog().flatMap((event) => event.commands.map((command) => command.requestId));
  assert.deepEqual(ids, ["panel_1", "panel_2"]);
});

test("input objects are copied: mutating them after an edit changes neither the project nor redo", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  const components = { Stats: { hp: 3 } };
  editor.createEntity({ sceneId: "scene_main", id: "e1", name: "One", components });
  const patch = { hp: 7 };
  editor.patchComponent("e1", "Stats", patch);

  components.Stats.hp = 999;
  patch.hp = 999;
  assert.deepEqual(editor.inspect("e1")?.entity.components, { Stats: { hp: 7 } });

  editor.undo();
  editor.undo();
  assert.equal(editor.inspect("e1"), undefined);
  editor.redo();
  editor.redo();
  assert.deepEqual(editor.inspect("e1")?.entity.components, { Stats: { hp: 7 } }, "redo replays the original values");
});

test("undo/redo cycles are stable: the project and history return to the same state every time", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  editor.createEntity({ sceneId: "scene_main", id: "e1", name: "One", parentId: "root" });
  editor.patchComponent("e1", "Stats", { hp: 4 });
  const done = JSON.stringify(bus.snapshot().project);
  editor.undo();
  editor.undo();
  const start = JSON.stringify(bus.snapshot().project);
  for (let cycle = 0; cycle < 10; cycle += 1) {
    editor.redo();
    editor.redo();
    assert.equal(JSON.stringify(bus.snapshot().project), done, `redone state, cycle ${cycle}`);
    assert.equal(editor.canRedo, false);
    editor.undo();
    editor.undo();
    assert.equal(JSON.stringify(bus.snapshot().project), start, `undone state, cycle ${cycle}`);
    assert.equal(editor.canUndo, false);
    assert.equal(editor.canRedo, true);
  }
});

test("undo then redo then undo again walks the whole history back to the start", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  editor.patchComponent("root", "Stats", { hp: 1 });
  editor.patchComponent("root", "Stats", { hp: 2 });
  editor.undo();
  editor.redo();
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 2 } });
  editor.undo();
  editor.undo();
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 10 } });
});

/** Tiny deterministic PRNG (mulberry32) so a failing run is reproducible from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: random edits/undo/redo keep the bus project equal to a snapshot-stack model", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const random = prng(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const bus = new CommandBus(fixture(), 0, { maxUndoDepth: 1000 });
    const editor = new EditorSession(bus);
    const states: string[] = [JSON.stringify(bus.snapshot().project)];
    let cursor = 0;
    let nextId = 0;
    const trace: string[] = [];

    const entityIds = (): string[] =>
      bus
        .snapshot()
        .project.scenes.flatMap((scene) => scene.entities.map((entity) => entity.id));

    for (let step = 0; step < 80; step += 1) {
      const roll = random();
      let action = "?";
      let edited = false;
      try {
        if (roll < 0.25) {
          action = "patch";
          editor.patchComponent("root", "Stats", { hp: Math.floor(random() * 100) });
          edited = true;
        } else if (roll < 0.45) {
          const id = `n${nextId++}`;
          const parent = random() < 0.5 ? undefined : pick(entityIds().filter((candidate) => candidate !== "other"));
          action = `create ${id} under ${String(parent)}`;
          editor.createEntity({
            sceneId: "scene_main",
            id,
            name: id,
            ...(parent !== undefined ? { parentId: parent } : {}),
          });
          edited = true;
        } else if (roll < 0.55) {
          const target = pick(entityIds());
          action = `delete ${target}`;
          editor.deleteEntity(target, random() < 0.5);
          edited = true;
        } else if (roll < 0.65) {
          const target = pick(entityIds());
          const parent = random() < 0.3 ? undefined : pick(entityIds());
          action = `reparent ${target} -> ${String(parent)}`;
          editor.reparent(target, parent);
          edited = true;
        } else if (roll < 0.85) {
          action = "undo";
          editor.undo();
          cursor -= 1;
        } else {
          action = "redo";
          editor.redo();
          cursor += 1;
        }
      } catch (error) {
        assert.ok(error instanceof CommandError, `seed ${seed} step ${step}: ${String(error)}`);
        action = `${action} (rejected ${error.code})`;
        edited = false;
        // A rejected undo/redo must not move the model.
        if (action.startsWith("undo") || action.startsWith("redo")) {
          const expectedUndo = cursor > 0;
          const expectedRedo = cursor < states.length - 1;
          if (action.startsWith("undo")) {
            assert.equal(expectedUndo, false, `seed ${seed} step ${step}: undo rejected although the model can undo`);
          } else {
            assert.equal(expectedRedo, false, `seed ${seed} step ${step}: redo rejected although the model can redo`);
          }
        }
      }
      if (edited) {
        states.splice(cursor + 1);
        states.push(JSON.stringify(bus.snapshot().project));
        cursor += 1;
      }
      trace.push(action);
      assert.equal(
        JSON.stringify(bus.snapshot().project),
        states[cursor],
        `seed ${seed} step ${step} (${action}) diverged from the model; trace: ${trace.join(" | ")}`,
      );
      assert.equal(editor.canUndo, cursor > 0, `seed ${seed} step ${step}: canUndo`);
      assert.equal(editor.canRedo, cursor < states.length - 1, `seed ${seed} step ${step}: canRedo`);
    }
  }
});
