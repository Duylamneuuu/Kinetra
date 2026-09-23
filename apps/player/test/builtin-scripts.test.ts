import assert from "node:assert/strict";
import test from "node:test";

import { ScriptRegistry } from "@kinetra/core";

import {
  BUILTIN_PLAYER_SCRIPTS,
  listBuiltinPlayerScriptIds,
} from "../src/builtin-scripts.ts";

test("builtin player scripts register the arena and player controllers", () => {
  assert.deepEqual(listBuiltinPlayerScriptIds(), [
    "ArenaEnemyController",
    "ArenaGameManager",
    "ArenaPlayerController",
    "PlayerController",
  ]);

  const registry = new ScriptRegistry();
  for (const [scriptId, factory] of BUILTIN_PLAYER_SCRIPTS) {
    registry.register(scriptId, factory);
  }
  assert.deepEqual(registry.ids(), listBuiltinPlayerScriptIds());

  const context = { entityId: "entity_player", sceneId: "scene_arena" };
  for (const [scriptId, factory] of BUILTIN_PLAYER_SCRIPTS) {
    const script = factory(context);
    assert.equal(typeof script.onCreate, "function", scriptId);
  }
});
