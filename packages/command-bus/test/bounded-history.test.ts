import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";

import {
  CommandBus,
  CommandError,
  DEFAULT_MAX_EVENT_LOG_LENGTH,
  DEFAULT_MAX_UNDO_DEPTH,
  type EngineCommand,
} from "../src/index.js";

const sceneId = stableId("scene", "bounded-history");

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "bounded-history"),
    name: "Bounded history",
    scenes: [
      {
        id: sceneId,
        name: "Main",
        entities: [{ id: "e1", name: "E1", components: { Transform: { x: 0 } } }],
      },
    ],
  };
}

function patch(i: number): EngineCommand {
  return {
    requestId: `r${i}`,
    command: "component.patch",
    payload: { entityId: "e1", component: "Transform", patch: { x: i } },
  };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof CommandError ? error.code : `non-command-error: ${String(error)}`;
  }
  return undefined;
}

test("defaults bound the undo stack and event log", () => {
  assert.equal(DEFAULT_MAX_UNDO_DEPTH, 100);
  assert.equal(DEFAULT_MAX_EVENT_LOG_LENGTH, 10_000);
});

test("undo depth is bounded: evicted tokens fail with UNDO_EXPIRED, retained ones still undo in LIFO order", () => {
  const bus = new CommandBus(project(), 0, { maxUndoDepth: 3 });
  const tokens: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    tokens.push(bus.execute(patch(i)).undoToken!);
  }

  // Tokens 1 and 2 were evicted; 3..5 are retained.
  assert.equal(code(() => bus.undo(tokens[0]!)), "UNDO_EXPIRED");
  assert.equal(code(() => bus.undo(tokens[1]!)), "UNDO_EXPIRED");
  assert.equal(code(() => bus.undo(tokens[2]!)), "UNDO_CONFLICT");

  bus.undo(tokens[4]!);
  bus.undo(tokens[3]!);
  bus.undo(tokens[2]!);
  const x = (bus.snapshot().project.scenes[0]!.entities[0]!.components.Transform as { x: number }).x;
  // Oldest retained snapshot is the state before the 3rd command (x = 2).
  assert.equal(x, 2);
});

test("a token that was never issued is still INVALID_COMMAND, not UNDO_EXPIRED", () => {
  const bus = new CommandBus(project(), 0, { maxUndoDepth: 1 });
  bus.execute(patch(1));
  bus.execute(patch(2));
  assert.equal(code(() => bus.undo("undo_999")), "INVALID_COMMAND");
  assert.equal(code(() => bus.undo("garbage")), "INVALID_COMMAND");
});

test("event log is a bounded ring that reports how many events were dropped", () => {
  const bus = new CommandBus(project(), 0, { maxEventLogLength: 4 });
  for (let i = 1; i <= 10; i += 1) {
    bus.execute(patch(i));
  }
  const log = bus.eventLog();
  assert.equal(log.length, 4);
  assert.deepEqual(
    log.map((event) => event.revision),
    [7, 8, 9, 10],
  );
  assert.equal(bus.droppedEventCount, 6);
  // Event ids keep increasing; they are never reused after eviction.
  assert.equal(log.at(-1)?.id, "event_10");
});

test("the default undo bound keeps memory flat across a long session", () => {
  const bus = new CommandBus(project());
  let last = "";
  for (let i = 1; i <= DEFAULT_MAX_UNDO_DEPTH + 25; i += 1) {
    last = bus.execute(patch(i)).undoToken!;
  }
  assert.equal(code(() => bus.undo("undo_1")), "UNDO_EXPIRED");
  assert.doesNotThrow(() => bus.undo(last));
});

test("Infinity opts out of the bounds", () => {
  const bus = new CommandBus(project(), 0, { maxUndoDepth: Infinity, maxEventLogLength: Infinity });
  const first = bus.execute(patch(1)).undoToken!;
  for (let i = 2; i <= 150; i += 1) {
    bus.execute(patch(i));
  }
  assert.equal(bus.eventLog().length, 150);
  assert.equal(code(() => bus.undo(first)), "UNDO_CONFLICT");
});

test("invalid bounds are rejected up front", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new CommandBus(project(), 0, { maxUndoDepth: bad }), RangeError);
    assert.throws(() => new CommandBus(project(), 0, { maxEventLogLength: bad }), RangeError);
  }
});

test("undo snapshots are not aliased to later commits (no shared mutable state)", () => {
  const bus = new CommandBus(project());
  const first = bus.execute(patch(1));
  bus.execute(patch(2));
  bus.undo(bus.execute(patch(3)).undoToken!);
  // Undoing 3 restores x=2, and the earlier token (1) is still behind token 2.
  assert.equal(code(() => bus.undo(first.undoToken!)), "UNDO_CONFLICT");
  const x = (bus.snapshot().project.scenes[0]!.entities[0]!.components.Transform as { x: number }).x;
  assert.equal(x, 2);
});

test("maxUndoDepth is exposed read-only and reflects the configured bound", () => {
  assert.equal(new CommandBus(project()).maxUndoDepth, DEFAULT_MAX_UNDO_DEPTH);
  assert.equal(new CommandBus(project(), 0, { maxUndoDepth: 3 }).maxUndoDepth, 3);
  assert.equal(new CommandBus(project(), 0, { maxUndoDepth: Infinity }).maxUndoDepth, Infinity);
});
