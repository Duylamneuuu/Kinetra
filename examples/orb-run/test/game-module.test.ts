import assert from "node:assert/strict";
import test from "node:test";

import { GameModuleRegistry, ScriptRegistry } from "@kinetra/core";

import {
  HeadlessSceneSimulation,
  ORB_RUN_GAME_ID,
  ORB_RUN_LEVEL_IDS,
  ORB_RUN_SCENE_ID,
  ORB_RUN_SCRIPT,
  createOrbRunGameModule,
  createOrbRunLevelProject,
  createOrbRunProject,
  walkTo,
  ORB_RUN_WINNING_ROUTE,
} from "../src/index.js";

test("Orb Run loads through the player's GameModuleRegistry and registers exactly its three scripts", async () => {
  const modules = new GameModuleRegistry("arena");
  modules.register(ORB_RUN_GAME_ID, () => createOrbRunGameModule(createOrbRunProject()));
  const loaded = await modules.load(ORB_RUN_GAME_ID);
  assert.equal(loaded.id, "orb-run");
  const registry = new ScriptRegistry();
  loaded.registerScripts(registry, { sceneId: ORB_RUN_SCENE_ID });
  for (const id of Object.values(ORB_RUN_SCRIPT)) assert.equal(registry.has(id), true, id);
  assert.equal(registry.has("ArenaGameManager"), false);
  assert.equal(registry.has("MarkerPulse"), false);
});

test("a missing scene is refused before anything is registered", () => {
  const registry = new ScriptRegistry();
  const module = createOrbRunGameModule(createOrbRunProject());
  assert.throws(() => module.registerScripts(registry, { sceneId: "scene_nope" }), /does not exist/);
  for (const id of Object.values(ORB_RUN_SCRIPT)) assert.equal(registry.has(id), false, id);
});

test("readGameState is undefined without a manager and ignores other scripts", () => {
  const module = createOrbRunGameModule(createOrbRunProject());
  assert.equal(module.readGameState?.([]), undefined);
  assert.equal(
    module.readGameState?.([{ entityId: "e", scriptId: ORB_RUN_SCRIPT.player, state: { finished: false } }]),
    undefined,
  );
});

test("the module's scripts play the winning route and readGameState reports the win", async () => {
  const project = createOrbRunProject();
  const registry = new ScriptRegistry();
  createOrbRunGameModule(project).registerScripts(registry, { sceneId: ORB_RUN_SCENE_ID });
  const simulation = new HeadlessSceneSimulation({ project, sceneId: ORB_RUN_SCENE_ID, scripts: registry });
  await simulation.start();
  const read = () =>
    createOrbRunGameModule(project).readGameState?.(
      simulation.scriptStates().map((s) => ({
        entityId: s.entityId,
        ...(s.scriptId ? { scriptId: s.scriptId } : {}),
        ...(s.state ? { state: s.state } : {}),
      })),
    );
  assert.equal(read()?.status, "playing");
  assert.equal(read()?.collectedCount, 0);
  for (const target of ORB_RUN_WINNING_ROUTE) walkTo(simulation, target);
  const game = read();
  assert.equal(game?.status, "won");
  assert.equal(game?.collectedCount, 3);
  assert.equal(game?.totalOrbs, 3);
  assert.equal(game?.exitUnlocked, true);
});

test("every shipped level yields a module that registers on a fresh registry each time", () => {
  for (const id of ORB_RUN_LEVEL_IDS) {
    const module = createOrbRunGameModule(createOrbRunLevelProject(id));
    const first = new ScriptRegistry();
    const second = new ScriptRegistry();
    module.registerScripts(first, { sceneId: ORB_RUN_SCENE_ID });
    module.registerScripts(second, { sceneId: ORB_RUN_SCENE_ID });
    for (const script of Object.values(ORB_RUN_SCRIPT)) {
      assert.equal(first.has(script) && second.has(script), true, `${id}/${script}`);
    }
  }
});
