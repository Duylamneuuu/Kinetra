import assert from "node:assert/strict";
import test from "node:test";

import { ScriptHost, type GameScript, type GameScriptContext } from "../src/scripts.js";

const context: GameScriptContext = { entityId: "e1", sceneId: "scene" };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function countingScript(counts: Record<string, number>): GameScript {
  const bump = (name: string) => async () => {
    counts[name] = (counts[name] ?? 0) + 1;
    await tick();
  };
  return {
    onCreate: bump("onCreate"),
    onStart: bump("onStart"),
    onStop: bump("onStop"),
    onDestroy: bump("onDestroy"),
  };
}

test("overlapping startAll() calls run onCreate/onStart once per script", async () => {
  const host = new ScriptHost();
  const counts: Record<string, number> = {};
  host.register({ id: "s1", context, script: countingScript(counts) });

  await Promise.all([host.startAll(), host.startAll(), host.startAll()]);

  assert.equal(counts.onCreate, 1);
  assert.equal(counts.onStart, 1);
  assert.equal(host.getExecutionState("s1")?.lifecycleState, "started");
});

test("overlapping stopAll() calls run onStop once per script", async () => {
  const host = new ScriptHost();
  const counts: Record<string, number> = {};
  host.register({ id: "s1", context, script: countingScript(counts) });
  await host.startAll();

  await Promise.all([host.stopAll(), host.stopAll()]);

  assert.equal(counts.onStop, 1);
  assert.equal(host.getExecutionState("s1")?.lifecycleState, "stopped");
});

test("overlapping destroyAll() calls run onStop/onDestroy once per script", async () => {
  const host = new ScriptHost();
  const counts: Record<string, number> = {};
  host.register({ id: "s1", context, script: countingScript(counts) });
  await host.startAll();

  await Promise.all([host.destroyAll(), host.destroyAll()]);

  assert.equal(counts.onStop, 1);
  assert.equal(counts.onDestroy, 1);
  assert.equal(host.hasScript("s1"), false);
});

test("startAll() can run again after the first call settled (late registrations start)", async () => {
  const host = new ScriptHost();
  const counts: Record<string, number> = {};
  host.register({ id: "a", context, script: countingScript(counts) });
  await host.startAll();
  const lateCounts: Record<string, number> = {};
  host.register({ id: "b", context, script: countingScript(lateCounts) });
  await host.startAll();

  assert.equal(counts.onCreate, 1, "already started script is not created twice");
  assert.equal(lateCounts.onCreate, 1);
  assert.equal(host.isStarted("b"), true);
});
