import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus, CommandError } from "@kinetra/command-bus";
import type { CommandEvent } from "@kinetra/command-bus";
import { KinetraAgentService } from "@kinetra/mcp-server";
import type { JsonObject, ProjectDocument } from "@kinetra/project-model";

import { EditorSession } from "../src/index.js";

function fixture(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_props",
    name: "Property fixture",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [
          {
            id: "hero",
            name: "Hero",
            components: {
              Stats: { hp: 10, tags: ["a"] },
              Transform: { position: [0, 0, 0], scale: [1, 1, 1] },
              Primitive: { kind: "box" },
              Flag: 7,
            },
          },
        ],
      },
    ],
  };
}

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

function editorError(action: () => unknown): CommandError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the edit to fail");
}

async function agentError(action: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await action();
  } catch (error) {
    return error as { code: string; message: string };
  }
  assert.fail("expected the edit to fail");
}

test("the same setProperty sequence and the equivalent MCP patches give identical change records, snapshot and event log", async () => {
  const editorBus = new CommandBus(fixture());
  const editor = new EditorSession(editorBus);
  const agent = new KinetraAgentService(fixture());

  const steps: Array<[() => ReturnType<EditorSession["setProperty"]>, JsonObject]> = [
    [() => editor.setProperty("hero", "Stats", "hp", 7), { hp: 7 }],
    [() => editor.setProperty("hero", "Stats", "buff.until", 3), { buff: { until: 3 } }],
    [() => editor.setProperty("hero", "Stats", ["tags", 1], "b"), { tags: ["a", "b"] }],
    [() => editor.setProperty("hero", "Transform", "position", [1, 2, 3]), { position: [1, 2, 3] }],
    [() => editor.setProperty("hero", "Transform", "position.1", 9), { position: [1, 9, 3] }],
    [() => editor.setProperty("hero", "Primitive", "kind", "sphere"), { kind: "sphere" }],
    [() => editor.setProperty("hero", "Camera", "fov", 70), { fov: 70 }],
  ];

  const editorChanges = [];
  const agentChanges = [];
  const components = ["Stats", "Stats", "Stats", "Transform", "Transform", "Primitive", "Camera"];
  for (const [index, [viaEditor, patch]] of steps.entries()) {
    editorChanges.push(viaEditor().changes);
    agentChanges.push(
      (await agent.patchComponent({ entityId: "hero", component: components[index] as string, patch })).changes,
    );
  }

  assert.deepEqual(editorChanges, agentChanges, "per-step change records");
  assert.deepEqual(editorBus.snapshot(), agent.bus.snapshot(), "resulting project and revision");
  assert.deepEqual(normalizedEvents(editorBus.eventLog()), normalizedEvents(agent.bus.eventLog()), "event log");
  const hero = editor.inspect("hero")?.entity.components;
  assert.deepEqual(hero?.Stats, { hp: 7, tags: ["a", "b"], buff: { until: 3 } });
  assert.deepEqual(hero?.Transform, { position: [1, 9, 3], scale: [1, 1, 1] });
});

test("invalid values fail with the same code and message as the MCP path and change nothing", async () => {
  const editorBus = new CommandBus(fixture());
  const editor = new EditorSession(editorBus);
  const agent = new KinetraAgentService(fixture());

  const cases: Array<[string, () => unknown, () => Promise<unknown>]> = [
    [
      "bad vector element",
      () => editor.setProperty("hero", "Transform", "position", [1, "x", 3]),
      () => agent.patchComponent({ entityId: "hero", component: "Transform", patch: { position: [1, "x", 3] } }),
    ],
    [
      "bad enum",
      () => editor.setProperty("hero", "Primitive", "kind", "torus"),
      () => agent.patchComponent({ entityId: "hero", component: "Primitive", patch: { kind: "torus" } }),
    ],
    [
      "bad number bound",
      () => editor.setProperty("hero", "Primitive", "roughness", 2),
      () => agent.patchComponent({ entityId: "hero", component: "Primitive", patch: { roughness: 2 } }),
    ],
    [
      "unknown entity",
      () => editor.setProperty("ghost", "Stats", "hp", 1),
      () => agent.patchComponent({ entityId: "ghost", component: "Stats", patch: { hp: 1 } }),
    ],
    [
      "component that is not an object",
      () => editor.setProperty("hero", "Flag", "x", 1),
      () => agent.patchComponent({ entityId: "hero", component: "Flag", patch: { x: 1 } }),
    ],
  ];

  for (const [label, viaEditor, viaAgent] of cases) {
    const fromEditor = editorError(viaEditor);
    const fromAgent = await agentError(viaAgent);
    assert.equal(fromEditor.code, fromAgent.code, `${label}: code`);
    assert.equal(fromEditor.message, fromAgent.message, `${label}: message`);
  }
  assert.equal(editor.revision, 0);
  assert.equal(agent.bus.revision, 0);
  assert.deepEqual(editorBus.snapshot(), agent.bus.snapshot());
  assert.equal(editor.canUndo, false, "a rejected edit leaves no undo entry");
});

test("a path that cannot be applied fails with INVALID_COMMAND before anything reaches the bus", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);
  const attempts: Array<[string, () => unknown]> = [
    ["empty path", () => editor.setProperty("hero", "Stats", "", 1)],
    ["empty array path", () => editor.setProperty("hero", "Stats", [], 1)],
    ["empty segment", () => editor.setProperty("hero", "Stats", "a..b", 1)],
    ["__proto__", () => editor.setProperty("hero", "Stats", "__proto__.polluted", 1)],
    ["through a scalar", () => editor.setProperty("hero", "Stats", "hp.deep", 1)],
    ["past the end of an array", () => editor.setProperty("hero", "Stats", "tags.5", "x")],
    ["negative index", () => editor.setProperty("hero", "Stats", ["tags", -1], "x")],
  ];
  for (const [label, attempt] of attempts) {
    assert.equal(editorError(attempt).code, "INVALID_COMMAND", label);
  }
  assert.equal(bus.revision, 0);
  assert.equal(bus.eventLog().length, 0);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("setProperty is one undoable edit and redo replays it", () => {
  const bus = new CommandBus(fixture());
  const editor = new EditorSession(bus);

  editor.setProperty("hero", "Transform", "position.2", 5);
  const after = bus.snapshot();
  assert.equal(editor.canUndo, true);

  editor.undo();
  assert.deepEqual(editor.inspect("hero")?.entity.components.Transform, { position: [0, 0, 0], scale: [1, 1, 1] });
  assert.equal(editor.canRedo, true);

  editor.redo();
  assert.deepEqual(bus.snapshot().project, after.project);
});

test("setProperty does not alias the caller's value and leaves siblings untouched", () => {
  const editor = new EditorSession(new CommandBus(fixture()));
  const value = { until: 3, list: [1] };
  editor.setProperty("hero", "Stats", "buff", value);
  value.list.push(2);
  value.until = 99;
  assert.deepEqual(editor.inspect("hero")?.entity.components.Stats, {
    hp: 10,
    tags: ["a"],
    buff: { until: 3, list: [1] },
  });
});

test("EditorSession.inspector reflects the bus after an edit and is undefined for a missing entity", () => {
  const editor = new EditorSession(new CommandBus(fixture()));
  assert.equal(editor.inspector("ghost"), undefined);

  const before = editor.inspector("hero");
  const kindBefore = before?.sections.find((s) => s.component === "Primitive")?.rows.find((r) => r.path === "kind");
  assert.equal(kindBefore?.value, "box");

  editor.setProperty("hero", "Primitive", "kind", "plane");
  const kindAfter = editor
    .inspector("hero")
    ?.sections.find((s) => s.component === "Primitive")
    ?.rows.find((r) => r.path === "kind");
  assert.equal(kindAfter?.value, "plane");
  assert.equal(kindBefore?.value, "box", "an earlier model is a snapshot, not a live view");
});
