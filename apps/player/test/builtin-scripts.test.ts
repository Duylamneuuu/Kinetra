import assert from "node:assert/strict";
import test from "node:test";

import { ScriptRegistry } from "@kinetra/core";

import {
  BUILTIN_PLAYER_SCRIPTS,
  describeUnresolvedScript,
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

  assert.match(
    describeUnresolvedScript("MissingScript", listBuiltinPlayerScriptIds()),
    /Script "MissingScript" could not be resolved\. Available scripts: ArenaEnemyController, ArenaGameManager, ArenaPlayerController, PlayerController\./,
  );
  assert.equal(
    describeUnresolvedScript("MissingScript", []),
    'Script "MissingScript" could not be resolved. Available scripts: (none).',
  );
  const many = Array.from({ length: 13 }, (_, index) => `Script${String(index).padStart(2, "0")}`);
  const capped = describeUnresolvedScript("MissingScript", many);
  assert.match(capped, /Script00, Script01/);
  assert.match(capped, /and 1 more/);
  assert.equal(capped.includes("Script12"), false);

  const context = { entityId: "entity_player", sceneId: "scene_arena" };
  for (const [scriptId, factory] of BUILTIN_PLAYER_SCRIPTS) {
    const script = factory(context);
    assert.equal(typeof script.onCreate, "function", scriptId);
  }
});
