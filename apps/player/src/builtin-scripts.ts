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

const SCRIPT_ID_LIST_LIMIT = 12;

export function describeUnresolvedScript(
  scriptId: string,
  registeredIds: readonly string[],
): string {
  const sorted = [...new Set(registeredIds.filter((id) => id.length > 0))].sort();
  if (sorted.length === 0) {
    return `Script "${scriptId}" could not be resolved. Available scripts: (none).`;
  }
  const shown = sorted.slice(0, SCRIPT_ID_LIST_LIMIT);
  const hidden = sorted.length - shown.length;
  const extra = hidden > 0 ? `, and ${hidden} more` : "";
  return `Script "${scriptId}" could not be resolved. Available scripts: ${shown.join(", ")}${extra}.`;
}
