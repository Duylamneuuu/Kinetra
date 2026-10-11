import assert from "node:assert/strict";
import test from "node:test";

import { ScriptHost, type GameScript, type GameScriptContext } from "../src/scripts.js";

const context: GameScriptContext = { entityId: "e1", sceneId: "scene" };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** Every hook records "<id>.<hook>.begin" and "<id>.<hook>.end" around an await, so overlap is visible. */
function loggedScript(id: string, events: string[]): GameScript {
  const hook = (name: string) => async () => {
    events.push(`${id}.${name}.begin`);
    await tick();
    events.push(`${id}.${name}.end`);
  };
  return {
    onCreate: hook("create"),
    onStart: hook("start"),
    onStop: hook("stop"),
    onDestroy: hook("destroy"),
  };
}

function hostWith(events: string[], ...ids: string[]): ScriptHost {
  const host = new ScriptHost();
  for (const id of ids) host.register({ id, context, script: loggedScript(id, events) });
  return host;
}

test("stopAll() issued while startAll() is still awaiting a hook stops every script once started", async () => {
  const events: string[] = [];
  const host = hostWith(events, "a", "b");

  const starting = host.startAll();
  await tick(); // a.create is in flight
  const stopping = host.stopAll();
  await Promise.all([starting, stopping]);

  for (const id of ["a", "b"]) {
    assert.equal(
      host.getExecutionState(id)?.lifecycleState,
      "stopped",
      `${id} must not be left running after stopAll() settled`,
    );
    assert.ok(events.includes(`${id}.stop.end`), `${id}.onStop must run`);
  }
  assert.ok(
    events.indexOf("a.start.end") < events.indexOf("a.stop.begin"),
    "onStop must not begin before onStart finished",
  );
});

test("destroyAll() issued during startAll() never runs onDestroy before onStart finished and leaves no live script", async () => {
  const events: string[] = [];
  const host = hostWith(events, "a", "b");

  const starting = host.startAll();
  await tick();
  const destroying = host.destroyAll();
  await Promise.all([starting, destroying]);

  assert.equal(host.hasScript("a"), false);
  assert.equal(host.hasScript("b"), false);
  for (const id of ["a", "b"]) {
    const startEnd = events.indexOf(`${id}.start.end`);
    const destroyBegin = events.indexOf(`${id}.destroy.begin`);
    if (destroyBegin !== -1 && startEnd !== -1) {
      assert.ok(startEnd < destroyBegin, `${id}.onDestroy began before its onStart finished`);
    }
    // Anything that was created is also destroyed exactly once.
    const created = events.filter((event) => event === `${id}.create.begin`).length;
    const destroyed = events.filter((event) => event === `${id}.destroy.begin`).length;
    assert.equal(destroyed, created, `${id}: onDestroy count must match onCreate count`);
  }
  // No hook of any script starts after the whole teardown finished.
  const lastDestroy = Math.max(...events.map((event, index) => (event.endsWith("destroy.end") ? index : -1)));
  assert.equal(
    events.slice(lastDestroy + 1).filter((event) => event.endsWith(".begin")).length,
    0,
    "no hook may begin after destroyAll() completed",
  );
});

test("startAll() issued during destroyAll() waits for it and starts nothing from the torn-down host", async () => {
  const events: string[] = [];
  const host = hostWith(events, "a");
  await host.startAll();
  events.length = 0;

  const destroying = host.destroyAll();
  await tick();
  const starting = host.startAll();
  await Promise.all([destroying, starting]);

  assert.equal(host.hasScript("a"), false);
  assert.equal(events.filter((event) => event === "a.create.begin").length, 0);
  assert.equal(events.filter((event) => event === "a.start.begin").length, 0);
});
