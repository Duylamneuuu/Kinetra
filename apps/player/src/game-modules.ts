import { GameModuleRegistry, type GameModule } from "@kinetra/core";
import {
  ArenaEnemyController,
  ArenaGameManager,
  ArenaPlayerController,
} from "@kinetra/reference-game";

/** The game the player runs when a start request does not name one. */
export const DEFAULT_GAME_ID = "arena";

/**
 * Arena, the reference game. It is the default module, so a start request
 * without `game` behaves exactly as it did before game modules existed.
 */
export const arenaGameModule: GameModule = {
  id: DEFAULT_GAME_ID,
  registerScripts(registry) {
    registry.register("ArenaPlayerController", () => new ArenaPlayerController());
    registry.register("ArenaEnemyController", () => new ArenaEnemyController());
    registry.register("ArenaGameManager", () => new ArenaGameManager());
  },
  readGameState(entities) {
    for (const entity of entities) {
      const session = entity.gameplay?.state?.session;
      if (typeof session === "object" && session !== null && !Array.isArray(session)) {
        return session as Record<string, unknown>;
      }
    }
    return undefined;
  },
};

/**
 * Create the registry of games this player build can run. Other games load
 * lazily (dynamic import) so their code stays out of the first-paint chunk.
 * Add a game here, not in the runtime controller.
 */
export function createBuiltinGameModules(): GameModuleRegistry {
  const registry = new GameModuleRegistry({ defaultId: DEFAULT_GAME_ID });
  registry.register(DEFAULT_GAME_ID, () => arenaGameModule);
  registry.register("orb-run", async () => (await import("@kinetra/example-orb-run/game-module")).orbRunGameModule);
  return registry;
}
