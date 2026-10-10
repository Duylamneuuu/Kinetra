# @kinetra/command-bus

The sole supported authoring mutation path: validation, transactions, revisions, dry runs, diffs, undo/checkpoints and replay-friendly events.

Every change to a project (from the editor, a script or an AI agent over MCP) is an `EngineCommand` executed by a `CommandBus`. The bus validates the command, applies it to a working copy, re-validates the whole project, and only then commits it and bumps the project **revision**. A rejected command never leaves a partial change behind.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `CommandBus` | class | Owns a validated `ProjectDocument` and its revision (`new CommandBus(project, initialRevision = 0, options?)`). `options.maxUndoDepth` (default 100) and `options.maxEventLogLength` (default 10000) bound the retained history; `Infinity` opts out; `bus.maxUndoDepth` reads the bound back. |
| `bus.execute(command)` | method | Runs one typed command as a one-command transaction. Returns a `CommandResult`. |
| `bus.executeUnknown(input)` | method | Same, but first parses untrusted JSON with `parseEngineCommand` (what MCP tools use). |
| `bus.executeTransaction(commands, options?)` | method | All-or-nothing batch: one revision bump, one undo token. |
| `bus.undo(undoToken, expectedProjectRevision?)` | method | Last-in, first-out undo; bumps the revision (history is never rewritten). |
| `bus.queryEntities(query?)` | method | Paged, filtered, read-only entity query (`sceneId`, `ids`, `component`, `nameContains`, `selectComponents`, `offset`, `limit`). |
| `bus.snapshot()` / `bus.revision` / `bus.eventLog()` | read | Deep-copied project + revision, and the replay-friendly list of `CommandEvent`s. |
| `parseEngineCommand(input)` | function | Validates unknown input into an `EngineCommand` or throws a structured `CommandError`. |
| `CommandError` | class | Structured error with a stable `code` and a `remediation` string an agent can act on. |

Commands: `scene.create`, `entity.create`, `component.patch`, `entity.reparent`, `entity.delete`. Every command carries a `requestId` and may carry `expectedProjectRevision` (optimistic concurrency) and `dryRun`.

Error codes: `STALE_REVISION`, `SCENE_NOT_FOUND`, `SCENE_ALREADY_EXISTS`, `ENTITY_NOT_FOUND`, `ENTITY_ALREADY_EXISTS`, `PARENT_NOT_FOUND`, `PARENT_CYCLE`, `CHILDREN_EXIST`, `COMPONENT_NOT_OBJECT`, `INVALID_COMMAND`, `UNDO_CONFLICT`, `UNDO_EXPIRED`.

History is bounded: every `execute` keeps one full-project snapshot for undo, so only the newest `maxUndoDepth` tokens stay undoable (older ones fail with `UNDO_EXPIRED`), and the event log keeps the newest `maxEventLogLength` events (`bus.droppedEventCount` says how many fell off, so a replay consumer can detect the gap).

## Example

```ts doc-check
import assert from "node:assert/strict";
import { CommandBus, CommandError } from "@kinetra/command-bus";
import { createProject, createScene } from "@kinetra/project-model";

const bus = new CommandBus(createProject({ name: "Demo", projectId: "project_demo" }));

// 1. Create a scene and an entity in one atomic transaction.
const created = bus.executeTransaction([
  {
    requestId: "r1",
    command: "scene.create",
    payload: { scene: createScene("Main", "scene_main") },
  },
  {
    requestId: "r2",
    command: "entity.create",
    payload: {
      sceneId: "scene_main",
      entity: { id: "entity_player", name: "Player", components: { Transform: { x: 0, y: 0 } } },
    },
  },
]);
assert.equal(created.revision, 1);
assert.ok(created.undoToken);

// 2. A dry run reports what would change but commits nothing.
const preview = bus.execute({
  requestId: "r3",
  command: "component.patch",
  dryRun: true,
  payload: { entityId: "entity_player", component: "Transform", patch: { x: 5 } },
});
assert.equal(preview.revision, 1);
assert.equal(preview.proposedRevision, 2);
assert.equal(bus.revision, 1);

// 3. A stale expectedProjectRevision is rejected with a remediation hint.
const patched = bus.execute({
  requestId: "r4",
  command: "component.patch",
  payload: { entityId: "entity_player", component: "Transform", patch: { x: 5 } },
});
assert.throws(
  () =>
    bus.execute({
      requestId: "r5",
      command: "component.patch",
      expectedProjectRevision: 1,
      payload: { entityId: "entity_player", component: "Transform", patch: { x: 9 } },
    }),
  (error: unknown) => error instanceof CommandError && error.code === "STALE_REVISION",
);

// 4. Query and undo. Undo is last-in, first-out and moves the revision forward.
const found = bus.queryEntities({ component: "Transform", nameContains: "play" });
assert.equal(found.total, 1);
assert.equal(bus.eventLog().length, 2);

// Only the most recent change can be undone; the undo itself is revision 3.
const undone = bus.undo(patched.undoToken!);
assert.equal(undone.revision, 3);
assert.equal(bus.eventLog().at(-1)?.operation, "undo");
```

## Proof level

Covered by `test/command-bus.test.ts`, `test/regressions.test.ts` and the model-based `test/property.test.ts` (all in the package `test` script): transactions, dry runs, stale revisions, LIFO undo, structured parent-cycle errors and reserved component names. See [`docs/STATUS.md`](../../docs/STATUS.md) for the project-wide proof table.

Not in scope here: persistence (see `@kinetra/mcp-server`, which serializes saves) and scene-runtime behaviour (see `@kinetra/core`).
