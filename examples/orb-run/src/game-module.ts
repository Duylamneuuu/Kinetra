import type { GameModule, GameModuleEntityView } from "@kinetra/core";

import { ORB_RUN_SCRIPT } from "./ids.js";
import { createOrbRunScriptRegistry } from "./scripts.js";

/**
 * Orb Run as a pluggable game for a runtime host such as the Electron player.
 *
 * Deliberately a separate entry point (`@kinetra/example-orb-run/game-module`):
 * the package index also exports the headless acceptance probe, which pulls in
 * the verification package, and a player must not bundle that.
 */
export const ORB_RUN_GAME_ID = "orb-run";

export const orbRunGameModule: GameModule = {
  id: ORB_RUN_GAME_ID,

  registerScripts(registry, { project, sceneId }) {
    // Scripts read their rules and the orb list from the authored project, so
    // the factories are built per start and handed to the host's registry.
    const built = createOrbRunScriptRegistry(project, sceneId);
    for (const scriptId of Object.values(ORB_RUN_SCRIPT)) {
      const factory = built.resolve(scriptId);
      if (factory) registry.register(scriptId, factory);
    }
  },

  readGameState(entities: readonly GameModuleEntityView[]): Record<string, unknown> | undefined {
    const manager = entities.find((entity) => entity.gameplay?.scriptId === ORB_RUN_SCRIPT.manager);
    const state = manager?.gameplay?.state;
    return state ? { ...state } : undefined;
  },
};
