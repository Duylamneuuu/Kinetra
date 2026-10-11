import assert from "node:assert/strict";
import test from "node:test";

import { ScriptHost, type GameScript, type GameScriptContext } from "../src/scripts.js";

const context: GameScriptContext = { entityId: "e1", sceneId: "scene" };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

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

// #337 item 3: a script registered while a start pass is running, followed by a second startAll()
// that shares the running pass, must be started by the time that call resolves.
test("a script registered during a running startAll() is started by a second startAll() that shares the pass", async () => {
  const events: string[] = [];
  const host = new ScriptHost();
  host.register({ id: "a", context, script: loggedScript("a", events) });

  const first = host.startAll();
  await tick(); // a.create in flight
  host.register({ id: "late", context, script: loggedScript("late", events) });
  const second = host.startAll();
  await Promise.all([first, second]);

  assert.equal(host.getExecutionState("a")?.lifecycleState, "started");
  assert.equal(
    host.getExecutionState("late")?.lifecycleState,
    "started",
    "startAll() resolved but the script registered during the pass was never started",
  );
  assert.equal(events.filter((event) => event === "late.start.begin").length, 1);
});

// A startAll() queued behind another pass must not share an older start pass that runs before it:
// start → destroy → startAll() has to resolve after the destroy, not with the first start.
test("startAll() issued after a queued destroyAll() does not resolve with the earlier start pass", async () => {
  const events: string[] = [];
  const host = new ScriptHost();
  host.register({ id: "a", context, script: loggedScript("a", events) });

  const order: string[] = [];
  const firstStart = host.startAll().then(() => order.push("start1"));
  await tick();
  const destroying = host.destroyAll().then(() => order.push("destroy"));
  const secondStart = host.startAll().then(() => order.push("start2"));
  await Promise.all([firstStart, destroying, secondStart]);

  assert.deepEqual(
    order,
    ["start1", "destroy", "start2"],
    "the startAll() issued after destroyAll() resolved before the destroy ran",
  );
  // The host can be repopulated after the teardown and the queued start covers it.
  host.register({ id: "b", context, script: loggedScript("b", events) });
  await host.startAll();
  assert.equal(host.getExecutionState("b")?.lifecycleState, "started");
});

test("stopAll() queued behind start → stop → stop still shares one stop pass", async () => {
  const events: string[] = [];
  const host = new ScriptHost();
  host.register({ id: "a", context, script: loggedScript("a", events) });
  const starting = host.startAll();
  const s1 = host.stopAll();
  const s2 = host.stopAll();
  assert.equal(s1, s2);
  await Promise.all([starting, s1, s2]);
  assert.equal(events.filter((event) => event === "a.stop.begin").length, 1);
});
