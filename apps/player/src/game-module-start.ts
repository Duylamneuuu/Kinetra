// Validates the scene and the game module before the running game is torn down.
// A rejected start must leave the current run, its assets and its scripts in place.

import {
  GameModuleError,
  ScriptRegistry,
  type GameModule,
  type GameModuleRegistry,
} from "@kinetra/core";

import { resolveStartScene, type StartSceneProject } from "./start-scene.js";

export async function startGameModule<TScene extends { readonly id: string }>(input: {
  project: StartSceneProject<TScene>;
  sceneId: string;
  gameId?: string | undefined;
  modules: GameModuleRegistry;
  teardown: () => Promise<void>;
}): Promise<{ scene: TScene; module: GameModule }> {
  const scene = resolveStartScene(input.project, input.sceneId);
  const module = await input.modules.load(input.gameId);
  const preview = new ScriptRegistry();
  try {
    module.registerScripts(preview, { sceneId: input.sceneId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GameModuleError(
      "game.registerFailed",
      `Game module "${module.id}" failed to register scripts: ${message}`,
      "registerScripts must only add factories to the registry it is given.",
    );
  }
  await input.teardown();
  return { scene, module };
}
