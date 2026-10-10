import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus, CommandError } from "@kinetra/command-bus";
import type { ProjectDocument } from "@kinetra/project-model";

import { EditorSession, describeChanges } from "../src/index.js";

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_editor",
    name: "Editor fixture",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [
          { id: "root", name: "Root", components: { Stats: { hp: 10 } } },
          { id: "kid", name: "Kid", parentId: "root", components: {} },
        ],
      },
    ],
  };
}

function setup(): { bus: CommandBus; editor: EditorSession } {
  const bus = new CommandBus(fixture());
  return { bus, editor: new EditorSession(bus) };
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

test("reads scenes, hierarchy and the inspector from the bus snapshot", () => {
  const { editor } = setup();
  assert.deepEqual(editor.scenes(), [{ id: "scene_main", name: "Main", entityCount: 2 }]);
  assert.deepEqual(
    editor.hierarchy("scene_main").map((row) => [row.entityId, row.depth]),
    [
      ["root", 0],
      ["kid", 1],
    ],
  );
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 10 } });
  assert.equal(editor.inspect("root")?.sceneId, "scene_main");
  assert.equal(editor.inspect("nope"), undefined);
  assert.equal(codeOf(() => editor.hierarchy("nope")), "SCENE_NOT_FOUND");
});

test("inspector results are copies: mutating them cannot change the project", () => {
  const { bus, editor } = setup();
  editor.inspect("root")!.entity.components["Stats"] = { hp: 999 };
  assert.deepEqual(bus.snapshot().project.scenes[0]!.entities[0]!.components, { Stats: { hp: 10 } });
});

test("every edit goes through the bus: revision, event log and request ids", () => {
  const { bus, editor } = setup();
  const created = editor.createEntity({ sceneId: "scene_main", id: "e1", name: "One", parentId: "root" });
  const patched = editor.patchComponent("e1", "Stats", { hp: 3 });
  assert.equal(created.revision, 1);
  assert.equal(patched.revision, 2);
  assert.equal(editor.revision, 2);
  assert.deepEqual(describeChanges(created.changes), ["created entity e1"]);
  const log = bus.eventLog();
  assert.deepEqual(
    log.map((event) => event.commands.map((command) => [command.command, command.requestId])),
    [
      [["entity.create", "editor_1"]],
      [["component.patch", "editor_2"]],
    ],
  );
});

test("a rejected edit leaves revision, history and project untouched", () => {
  const { bus, editor } = setup();
  const before = bus.snapshot();
  assert.equal(codeOf(() => editor.reparent("root", "kid")), "PARENT_CYCLE");
  assert.equal(codeOf(() => editor.deleteEntity("root")), "CHILDREN_EXIST");
  assert.equal(codeOf(() => editor.patchComponent("ghost", "Stats", {})), "ENTITY_NOT_FOUND");
  assert.deepEqual(bus.snapshot(), before);
  assert.equal(editor.canUndo, false);
  assert.equal(bus.eventLog().length, 0);
});

test("undo and redo round-trip an edit; a new edit clears redo", () => {
  const { bus, editor } = setup();
  editor.patchComponent("root", "Stats", { hp: 1 });
  editor.createEntity({ sceneId: "scene_main", id: "e1", name: "One" });
  assert.equal(editor.canUndo, true);
  assert.equal(editor.canRedo, false);

  editor.undo();
  assert.equal(editor.inspect("e1"), undefined);
  assert.equal(editor.canRedo, true);

  editor.redo();
  assert.equal(editor.inspect("e1")?.entity.name, "One");
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 1 } });
  assert.equal(editor.canRedo, false);

  editor.undo();
  editor.undo();
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 10 } });
  assert.equal(editor.canUndo, false);
  assert.equal(codeOf(() => editor.undo()), "INVALID_COMMAND");

  editor.patchComponent("root", "Stats", { hp: 5 });
  assert.equal(editor.canRedo, false, "a fresh edit drops the redo branch");
  assert.equal(codeOf(() => editor.redo()), "INVALID_COMMAND");
  assert.equal(bus.revision, 7);
});

test("redo sends fresh request ids rather than reusing the original ones", () => {
  const { bus, editor } = setup();
  editor.patchComponent("root", "Stats", { hp: 1 });
  editor.undo();
  editor.redo();
  const ids = bus
    .eventLog()
    .flatMap((event) => event.commands.map((command) => command.requestId));
  assert.deepEqual(ids, ["editor_1", "editor_2"]);
});

test("another client committing on top makes undo fail with UNDO_CONFLICT and drops redo", () => {
  const { bus, editor } = setup();
  editor.patchComponent("root", "Stats", { hp: 1 });
  editor.patchComponent("root", "Stats", { hp: 2 });
  editor.undo();
  assert.equal(editor.canRedo, true);
  editor.redo();

  bus.execute({
    requestId: "agent_1",
    command: "component.patch",
    payload: { entityId: "root", component: "Stats", patch: { hp: 99 } },
  });
  assert.equal(editor.canRedo, false);
  assert.equal(codeOf(() => editor.undo()), "UNDO_CONFLICT");
  // The agent's change is intact.
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 99 } });
});

test("a stale redo (another client changed things after our undo) is not replayed", () => {
  const { bus, editor } = setup();
  editor.createEntity({ sceneId: "scene_main", id: "e1", name: "One" });
  editor.undo();
  bus.execute({
    requestId: "agent_1",
    command: "entity.create",
    payload: { sceneId: "scene_main", entity: { id: "e1", name: "Agent's", components: {} } },
  });
  assert.equal(editor.canRedo, false);
  assert.equal(codeOf(() => editor.redo()), "INVALID_COMMAND");
  assert.equal(editor.inspect("e1")?.entity.name, "Agent's");
});

test("selection drops entities that are deleted or undone, and rejects unknown ids", () => {
  const { editor } = setup();
  editor.createEntity({ sceneId: "scene_main", id: "e1", name: "One" });
  editor.select(["e1", "root", "e1"]);
  assert.deepEqual(editor.selection, ["e1", "root"]);

  assert.equal(codeOf(() => editor.select(["root", "ghost"])), "ENTITY_NOT_FOUND");
  assert.deepEqual(editor.selection, ["e1", "root"], "a rejected select changes nothing");

  editor.undo();
  assert.deepEqual(editor.selection, ["root"]);
  editor.deleteEntity("kid");
  editor.select(["root"]);
  editor.deleteEntity("root", true);
  assert.deepEqual(editor.selection, []);

  editor.clearSelection();
  assert.deepEqual(editor.selection, []);
  const huge = Array.from({ length: 501 }, (_, index) => `x${index}`);
  assert.equal(codeOf(() => editor.select(huge)), "INVALID_COMMAND");
});

test("reparent to root and cascade delete behave like the bus commands", () => {
  const { editor } = setup();
  editor.reparent("kid");
  assert.deepEqual(
    editor.hierarchy("scene_main").map((row) => [row.entityId, row.depth]),
    [
      ["root", 0],
      ["kid", 0],
    ],
  );
  editor.reparent("kid", "root");
  const deleted = editor.deleteEntity("root", true);
  assert.deepEqual(describeChanges(deleted.changes).sort(), ["deleted entity kid", "deleted entity root"]);
  assert.equal(editor.scenes()[0]!.entityCount, 0);
  editor.undo();
  assert.equal(editor.scenes()[0]!.entityCount, 2);
});

test("an undo token another client already consumed is dropped, not left blocking the editor's older edits", () => {
  const { bus, editor } = setup();
  editor.patchComponent("root", "Stats", { hp: 1 });
  const second = editor.patchComponent("root", "Stats", { hp: 2 });
  // An MCP client undoes the editor's latest edit through the bus.
  bus.undo(second.undoToken!);
  assert.equal(codeOf(() => editor.undo()), "INVALID_COMMAND");
  assert.equal(editor.canUndo, true, "the editor's older edit is still undoable");
  editor.undo();
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 10 } });
  assert.equal(editor.canUndo, false);
});

test("evicted undo tokens (maxUndoDepth) clear the editor history instead of failing forever", () => {
  const bus = new CommandBus(fixture(), 0, { maxUndoDepth: 2 });
  // The default would follow the bus (2); an explicitly larger history is what can outlive it.
  const editor = new EditorSession(bus, { maxHistory: 100 });
  for (let hp = 1; hp <= 4; hp += 1) {
    editor.patchComponent("root", "Stats", { hp });
  }
  editor.undo();
  editor.undo();
  assert.equal(codeOf(() => editor.undo()), "UNDO_EXPIRED");
  assert.equal(editor.canUndo, false, "older tokens were evicted too, so nothing is left to undo");
  assert.equal(codeOf(() => editor.undo()), "INVALID_COMMAND");
  assert.deepEqual(editor.inspect("root")?.entity.components, { Stats: { hp: 2 } });
});

test("createScene then populate it, all undoable", () => {
  const { editor } = setup();
  editor.createScene({ id: "scene_two", name: "Two" });
  editor.createEntity({ sceneId: "scene_two", id: "t1", name: "T1" });
  assert.equal(editor.scenes().length, 2);
  assert.equal(codeOf(() => editor.createScene({ id: "scene_two", name: "Dup" })), "SCENE_ALREADY_EXISTS");
  editor.undo();
  editor.undo();
  assert.equal(editor.scenes().length, 1);
});
