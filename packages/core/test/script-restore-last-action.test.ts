import assert from "node:assert/strict";
import test from "node:test";
import { PlayerControllerScript, ScriptHost } from "../src/index.js";

// getState() leaves lastAction out while it is unset, so a state saved before the player acted has
// no such key. Restoring it must put the script back to "unset", not keep the live value.

test("PlayerControllerScript.restoreState clears lastAction when the saved state has none", () => {
  const script = new PlayerControllerScript();
  const saved = script.getState();
  assert.deepEqual(saved, { moveCount: 0, jumpCount: 0 });

  script.moveCount = 3;
  script.lastAction = "player.moveRight";

  script.restoreState(saved);
  assert.equal(script.lastAction, undefined);
  assert.deepEqual(script.getState(), saved);
});

test("a prepared restore without lastAction clears it on commit and brings it back on rollback", async () => {
  const host = new ScriptHost();
  const script = new PlayerControllerScript();
  host.register({ id: "hero", scriptId: "PlayerController", context: { entityId: "hero", sceneId: "main" }, script });
  await host.startAll();

  script.lastAction = "player.jump";
  script.jumpCount = 1;

  const prepared = await host.prepareScriptRestore("hero", { moveCount: 0, jumpCount: 0 });
  assert.equal(script.lastAction, "player.jump", "prepare must not mutate the live script");

  await prepared.commit();
  assert.deepEqual(script.getState(), { moveCount: 0, jumpCount: 0 });

  await prepared.rollback();
  assert.deepEqual(script.getState(), { moveCount: 0, jumpCount: 1, lastAction: "player.jump" });

  await host.destroyAll();
});

test("a state with lastAction still restores it", () => {
  const script = new PlayerControllerScript();
  script.restoreState({ moveCount: 2, jumpCount: 1, lastAction: "player.jump" });
  assert.deepEqual(script.getState(), { moveCount: 2, jumpCount: 1, lastAction: "player.jump" });
});
