import assert from "node:assert/strict";
import test from "node:test";

import { GameModuleRegistry, ScriptRegistry } from "@kinetra/core";

import { startGameModule } from "../src/game-module-start.js";
import { createPlayerGameModules } from "../src/game-modules.js";

test("a bad scene, unknown game, or failing registerScripts does not tear the run down", async () => {
  let tornDown = 0;
  const modules = new GameModuleRegistry("arena");
  modules.register("arena", () => ({
    id: "arena",
    registerScripts(registry) {
      registry.register("ArenaGameManager", () => ({}));
    },
  }));
  modules.register("boom", () => ({
    id: "boom",
    registerScripts() {
      throw new Error("nope");
    },
  }));
  const project = { scenes: [{ id: "scene_a" }] };
  const teardown = async (): Promise<void> => {
    tornDown += 1;
  };

  await assert.rejects(
    () => startGameModule({ project, sceneId: "missing", modules, teardown }),
    /does not exist/,
  );
  await assert.rejects(
    () => startGameModule({ project, sceneId: "scene_a", gameId: "nope", modules, teardown }),
    /\[game\.unknown\]/,
  );
  await assert.rejects(
    () => startGameModule({ project, sceneId: "scene_a", gameId: "boom", modules, teardown }),
    /\[game\.registerFailed\]/,
  );
  assert.equal(tornDown, 0);

  const started = await startGameModule({ project, sceneId: "scene_a", modules, teardown });
  assert.equal(tornDown, 1);
  assert.equal(started.scene.id, "scene_a");
  assert.equal(started.module.id, "arena");
  const registry = new ScriptRegistry();
  started.module.registerScripts(registry, { sceneId: "scene_a" });
  assert.equal(registry.has("ArenaGameManager"), true);
});

test("arena and marker register disjoint script ids", async () => {
  const modules = createPlayerGameModules();
  const arena = await modules.load();
  const marker = await modules.load("marker");
  const arenaScripts = new ScriptRegistry();
  const markerScripts = new ScriptRegistry();
  arena.registerScripts(arenaScripts, { sceneId: "scene" });
  marker.registerScripts(markerScripts, { sceneId: "scene" });
  assert.equal(arenaScripts.has("ArenaGameManager"), true);
  assert.equal(arenaScripts.has("MarkerPulse"), false);
  assert.equal(markerScripts.has("MarkerPulse"), true);
  assert.equal(markerScripts.has("ArenaGameManager"), false);
  const state = marker.readGameState?.([]);
  assert.equal(typeof state?.fingerprint, "string");
  assert.equal(state?.pulses, 0);
});
