import assert from "node:assert/strict";
import test from "node:test";

import { ScriptHost, type GameScript, type GameScriptContext } from "../src/scripts.js";

function context(entityId: string, logs: unknown[]): GameScriptContext {
  return {
    entityId,
    sceneId: "scene",
    log: (level, category, data) => logs.push({ level, category, data }),
  };
}

test("a script that throws an Error with an empty message is still reported as failed with a readable reason", async () => {
  const host = new ScriptHost();
  const logs: unknown[] = [];
  const script: GameScript = {
    onUpdate() {
      throw new Error("");
    },
  };
  host.register({ id: "s1", context: context("e1", logs), script });
  await host.startAll();
  host.update(1 / 60);

  const state = host.getExecutionState("s1")!;
  assert.equal(state.lifecycleState, "error");
  assert.equal(typeof state.error, "string", "error must be reported even when the message is empty");
  assert.ok(state.error!.length > 0, "error text must not be empty");
  const logged = logs.find((entry) => (entry as { category: string }).category === "script.error") as {
    data: { error: string };
  };
  assert.ok(logged.data.error.length > 0);
});

test("a throw during onCreate with an empty message keeps the error visible", async () => {
  const host = new ScriptHost();
  host.register({
    id: "s2",
    context: context("e2", []),
    script: {
      onCreate() {
        throw new TypeError("");
      },
    },
  });
  await host.startAll();
  const state = host.getExecutionState("s2")!;
  assert.equal(state.lifecycleState, "error");
  assert.match(state.error ?? "", /TypeError/);
});

test("validateScriptRestoreState explains an async validator instead of returning a blank rejection", () => {
  const host = new ScriptHost();
  host.register({
    id: "s3",
    context: context("e3", []),
    script: {
      restoreState() {},
      validateRestoreState: () => Promise.resolve({ valid: true }),
    } as unknown as GameScript,
  });
  const result = host.validateScriptRestoreState("s3", {});
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /synchronous/);
});
