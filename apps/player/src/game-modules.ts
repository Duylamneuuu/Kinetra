// Built-in games the Electron player can start. Arena is the default and is
// registered statically. Marker is a dynamic import so its chunk, including
// `@kinetra/asset-pipeline/pure`, is not in the first-paint bundle.

import {
  GameModuleRegistry,
  PlayerControllerScript,
  type GameModule,
} from "@kinetra/core";
import {
  ArenaEnemyController,
  ArenaGameManager,
  ArenaPlayerController,
} from "@kinetra/reference-game";

const arenaGameModule: GameModule = {
  id: "arena",
  registerScripts(registry) {
    registry.register("PlayerController", () => new PlayerControllerScript());
    registry.register("ArenaPlayerController", () => new ArenaPlayerController());
    registry.register("ArenaEnemyController", () => new ArenaEnemyController());
    registry.register("ArenaGameManager", () => new ArenaGameManager());
  },
  readGameState(scripts) {
    for (const script of scripts) {
      if (script.scriptId !== "ArenaGameManager") continue;
      const session = script.state?.session;
      if (typeof session === "object" && session !== null && !Array.isArray(session)) {
        return session as Record<string, unknown>;
      }
    }
    return undefined;
  },
};

export function createPlayerGameModules(): GameModuleRegistry {
  const registry = new GameModuleRegistry("arena");
  registry.register("arena", () => arenaGameModule);
  registry.register("marker", async () => {
    const loaded = await import("@kinetra/example-marker/game-module");
    return loaded.markerGameModule;
  });
  return registry;
}
