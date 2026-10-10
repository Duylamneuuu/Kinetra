import assert from "node:assert/strict";
import test from "node:test";

import type { ChangeRecord, CommandEvent } from "@kinetra/command-bus";
import { CommandBus } from "@kinetra/command-bus";
import { KinetraAgentService } from "@kinetra/mcp-server";
import type { ProjectDocument } from "@kinetra/project-model";

import { EditorSession } from "../src/index.js";

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_parity",
    name: "Parity fixture",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [
          { id: "hero", name: "Hero", components: { Stats: { hp: 10, tags: ["a"] } } },
          { id: "helmet", name: "Helmet", parentId: "hero", components: {} },
        ],
      },
    ],
  };
}

/** The event log minus request ids: ids are client-chosen labels, not part of the resulting diff. */
function normalizedEvents(events: CommandEvent[]): unknown[] {
  return events.map((event) => ({
    operation: event.operation,
    revision: event.revision,
    changes: event.changes,
    commands: event.commands.map((command) => {
      const { requestId: _requestId, ...rest } = command;
      return rest;
    }),
  }));
}

test("the editor and an MCP client produce identical diffs for the same edits", async () => {
  const editorBus = new CommandBus(fixture());
  const editor = new EditorSession(editorBus);
  const agent = new KinetraAgentService(fixture());

  const editorChanges: ChangeRecord[][] = [];
  const agentChanges: ChangeRecord[][] = [];

  editorChanges.push(editor.createScene({ id: "scene_two", name: "Two" }).changes);
  agentChanges.push((await agent.createScene({ id: "scene_two", name: "Two" })).changes);

  editorChanges.push(
    editor.createEntity({
      sceneId: "scene_main",
      id: "sword",
      name: "Sword",
      parentId: "hero",
      components: { Stats: { damage: 4 } },
    }).changes,
  );
  agentChanges.push(
    (
      await agent.createEntity({
        sceneId: "scene_main",
        id: "sword",
        name: "Sword",
        parentId: "hero",
        components: { Stats: { damage: 4 } },
      })
    ).changes,
  );

  editorChanges.push(editor.patchComponent("hero", "Stats", { hp: 7, buff: { until: 3 } }).changes);
  agentChanges.push(
    (await agent.patchComponent({ entityId: "hero", component: "Stats", patch: { hp: 7, buff: { until: 3 } } }))
      .changes,
  );

  editorChanges.push(editor.reparent("sword").changes);
  agentChanges.push((await agent.reparentEntity({ entityId: "sword" })).changes);

  editorChanges.push(editor.reparent("sword", "helmet").changes);
  agentChanges.push((await agent.reparentEntity({ entityId: "sword", parentId: "helmet" })).changes);

  editorChanges.push(editor.deleteEntity("hero", true).changes);
  agentChanges.push((await agent.deleteEntity({ entityId: "hero", cascade: true })).changes);

  assert.deepEqual(editorChanges, agentChanges, "per-command change records");
  assert.deepEqual(editorBus.snapshot(), agent.bus.snapshot(), "resulting project and revision");
  assert.deepEqual(
    normalizedEvents(editorBus.eventLog()),
    normalizedEvents(agent.bus.eventLog()),
    "replayable event log",
  );
  assert.deepEqual(
    normalizedEvents(editorBus.eventLog().filter((event) => event.revision > 2)),
    normalizedEvents(agent.diffSince(2).events),
    "diffSince sees the editor's edits exactly as it sees an agent's",
  );
});

test("the editor and an MCP client fail identically on the same invalid edit", async () => {
  const editor = new EditorSession(new CommandBus(fixture()));
  const agent = new KinetraAgentService(fixture());

  const codeOfEditor = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "none";
  };
  const codeOfAgent = async (action: () => Promise<unknown>): Promise<string> => {
    try {
      await action();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "none";
  };

  const pairs: Array<[string, () => unknown, () => Promise<unknown>]> = [
    [
      "PARENT_CYCLE",
      () => editor.reparent("hero", "helmet"),
      () => agent.reparentEntity({ entityId: "hero", parentId: "helmet" }),
    ],
    [
      "CHILDREN_EXIST",
      () => editor.deleteEntity("hero"),
      () => agent.deleteEntity({ entityId: "hero" }),
    ],
    [
      "ENTITY_NOT_FOUND",
      () => editor.patchComponent("ghost", "Stats", {}),
      () => agent.patchComponent({ entityId: "ghost", component: "Stats", patch: {} }),
    ],
    [
      "ENTITY_ALREADY_EXISTS",
      () => editor.createEntity({ sceneId: "scene_main", id: "hero", name: "Dup" }),
      () => agent.createEntity({ sceneId: "scene_main", id: "hero", name: "Dup" }),
    ],
    [
      "SCENE_NOT_FOUND",
      () => editor.createEntity({ sceneId: "nope", id: "x", name: "X" }),
      () => agent.createEntity({ sceneId: "nope", id: "x", name: "X" }),
    ],
  ];

  for (const [expected, viaEditor, viaAgent] of pairs) {
    assert.equal(codeOfEditor(viaEditor), expected, `editor: ${expected}`);
    assert.equal(await codeOfAgent(viaAgent), expected, `agent: ${expected}`);
  }
  assert.equal(editor.revision, 0);
  assert.equal(agent.bus.revision, 0);
});
