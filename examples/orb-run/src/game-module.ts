import type { GameModule, GameModuleScriptState } from "@kinetra/core";
import type { ProjectDocument } from "@kinetra/project-model";

import { ORB_RUN_SCRIPT } from "./ids.js";
import { createOrbRunScriptRegistry } from "./scripts.js";

/** Id Orb Run registers under in a `GameModuleRegistry` (the player's `--game orb-run`). */
export const ORB_RUN_GAME_ID = "orb-run";

/**
 * Orb Run as a player `GameModule`. `GameModuleContext` carries only `sceneId`, but
 * the Orb Run factories need the authored rules, walls, mud and orb list, so the
 * module is built from the project it will run (engine request: the context should
 * carry the project). `registerScripts` fails with the scene error before anything
 * is registered when the scene is missing or the project has no single manager.
 */
export function createOrbRunGameModule(project: ProjectDocument): GameModule {
  return {
    id: ORB_RUN_GAME_ID,
    registerScripts(registry, context) {
      const scripts = createOrbRunScriptRegistry(project, context.sceneId);
      for (const scriptId of Object.values(ORB_RUN_SCRIPT)) {
        const factory = scripts.resolve(scriptId);
        if (!factory) throw new Error(`Orb Run script "${scriptId}" has no factory`);
        registry.register(scriptId, factory);
      }
    },
    readGameState(scripts: readonly GameModuleScriptState[]) {
      for (const script of scripts) {
        if (script.scriptId !== ORB_RUN_SCRIPT.manager || !script.state) continue;
        const { status, collectedCount, totalOrbs, exitUnlocked, elapsedSeconds, remainingSeconds } = script.state;
        return { status, collectedCount, totalOrbs, exitUnlocked, elapsedSeconds, remainingSeconds };
      }
      return undefined;
    },
  };
}
