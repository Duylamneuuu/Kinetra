import {
  PlayerControllerScript,
  type GameScriptFactory,
} from "@kinetra/core";
import {
  ArenaEnemyController,
  ArenaGameManager,
  ArenaPlayerController,
} from "@kinetra/reference-game";

/** Script ids the player registers before any test-only fixtures. */
export const BUILTIN_PLAYER_SCRIPTS: ReadonlyArray<
  readonly [string, GameScriptFactory]
> = [
  ["ArenaEnemyController", () => new ArenaEnemyController()],
  ["ArenaGameManager", () => new ArenaGameManager()],
  ["ArenaPlayerController", () => new ArenaPlayerController()],
  ["PlayerController", () => new PlayerControllerScript()],
];

export function listBuiltinPlayerScriptIds(): string[] {
  return BUILTIN_PLAYER_SCRIPTS.map(([scriptId]) => scriptId).sort();
}
