import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupersessionGuard } from "../src/supersession-guard.js";
import { loadSaveFailure, loadSaveSupersededMessage } from "../src/save-failure.js";

/** Stand-in for the controller fields loadSave guards: the runtime and the script host. */
interface FakeController {
  runtime: object | undefined;
  scripts: object;
  applied: string[];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Same shape as PlayerRuntimeController.loadSave: capture, await a hung storage read, check the
 * guard, and only then apply. Anything applied after the guard trips would be a bug.
 */
async function fakeLoadSave(
  controller: FakeController,
  read: Promise<string>,
) {
  const guard = createSupersessionGuard(() => [controller.runtime, controller.scripts]);
  const entityId = await read;
  if (guard.isSuperseded()) {
    return loadSaveFailure("preparation", loadSaveSupersededMessage(), "slot-1");
  }
  controller.applied.push(entityId);
  return { success: true as const };
}

test("a load is not superseded while the runtime and script host are untouched", async () => {
  const controller: FakeController = { runtime: {}, scripts: {}, applied: [] };
  const gate = deferred<string>();
  const pending = fakeLoadSave(controller, gate.promise);
  gate.resolve("hero");
  assert.deepEqual(await pending, { success: true });
  assert.deepEqual(controller.applied, ["hero"]);
});

test("stop() then start() during a hung read applies nothing and fails in preparation", async () => {
  const controller: FakeController = { runtime: {}, scripts: {}, applied: [] };
  const gate = deferred<string>();
  const pending = fakeLoadSave(controller, gate.promise);

  // stop() clears the runtime and start() builds a fresh runtime and script host while the read hangs.
  controller.runtime = undefined;
  controller.runtime = {};
  controller.scripts = {};
  gate.resolve("hero");

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal("phase" in result ? result.phase : undefined, "preparation");
  assert.equal("slotId" in result ? result.slotId : undefined, "slot-1");
  assert.deepEqual(controller.applied, []);
});

test("stop() alone (runtime cleared, never restarted) also supersedes the load", async () => {
  const controller: FakeController = { runtime: {}, scripts: {}, applied: [] };
  const gate = deferred<string>();
  const pending = fakeLoadSave(controller, gate.promise);
  controller.runtime = undefined;
  gate.resolve("hero");
  const result = await pending;
  assert.equal(result.success, false);
  assert.deepEqual(controller.applied, []);
});

test("replacing only the script host is enough to supersede", () => {
  const state = { runtime: {} as object, scripts: {} as object };
  const guard = createSupersessionGuard(() => [state.runtime, state.scripts]);
  assert.equal(guard.isSuperseded(), false);
  state.scripts = {};
  assert.equal(guard.isSuperseded(), true);
});

test("swapping a value and swapping it back is not a supersession (identity is what is compared)", () => {
  const first = {};
  const state = { runtime: first as object };
  const guard = createSupersessionGuard(() => [state.runtime]);
  state.runtime = {};
  assert.equal(guard.isSuperseded(), true);
  state.runtime = first;
  assert.equal(guard.isSuperseded(), false);
});

test("equal-looking but distinct objects count as replaced", () => {
  const state = { runtime: { id: 1 } };
  const guard = createSupersessionGuard(() => [state.runtime]);
  state.runtime = { id: 1 };
  assert.equal(guard.isSuperseded(), true);
});

test("a changed number of tracked values is superseded and a captured snapshot is not aliased", () => {
  let live: unknown[] = [1, 2];
  const guard = createSupersessionGuard(() => live);
  live = [1, 2, 3];
  assert.equal(guard.isSuperseded(), true);

  const mutable: unknown[] = ["a"];
  const aliasGuard = createSupersessionGuard(() => mutable);
  mutable[0] = "b";
  assert.equal(aliasGuard.isSuperseded(), true, "mutating the array read() returned must be seen");
});
