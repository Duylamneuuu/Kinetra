import type { ScriptRegistry } from "./scripts.js";

/** Lowercase id, 1–64 characters: `arena`, `marker`, `orb-run`. */
export const GAME_MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type GameModuleErrorCode =
  | "game.invalidId"
  | "game.unknown"
  | "game.loadFailed"
  | "game.invalidModule"
  | "game.registerFailed";

export class GameModuleError extends Error {
  readonly code: GameModuleErrorCode;
  readonly remediation: string;

  constructor(code: GameModuleErrorCode, message: string, remediation: string) {
    super(`[${code}] ${message}`);
    this.name = "GameModuleError";
    this.code = code;
    this.remediation = remediation;
  }
}

export interface GameModuleContext {
  readonly sceneId: string;
}

/** One script's published state, already copied by the host. */
export interface GameModuleScriptState {
  readonly entityId: string;
  readonly scriptId?: string;
  readonly state?: Record<string, unknown>;
}

/**
 * A game the player can run. `registerScripts` must only add factories to the
 * registry it is given. The player calls it on a fresh registry for every start,
 * so one game's scripts do not remain registered for the next game.
 */
export interface GameModule {
  readonly id: string;
  registerScripts(registry: ScriptRegistry, context: GameModuleContext): void;
  readGameState?(scripts: readonly GameModuleScriptState[]): Record<string, unknown> | undefined;
}

export type GameModuleLoader = () => GameModule | Promise<GameModule>;

function assertGameId(id: string): string {
  if (typeof id !== "string" || id.length > 64 || !GAME_MODULE_ID_PATTERN.test(id)) {
    throw new GameModuleError(
      "game.invalidId",
      `Game module id "${String(id)}" is not a lowercase identifier.`,
      'Use 1–64 characters matching "^[a-z][a-z0-9]*(-[a-z0-9]+)*$", for example "marker".',
    );
  }
  return id;
}

function isGameModule(value: unknown): value is GameModule {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { id?: unknown; registerScripts?: unknown };
  return typeof record.id === "string" && typeof record.registerScripts === "function";
}

/**
 * Named loaders for game modules. Loaders are cached after a successful load.
 * A failed load is not cached. Ids are map keys, so they never collide with
 * `Object.prototype`.
 */
export class GameModuleRegistry {
  readonly #loaders = new Map<string, GameModuleLoader>();
  readonly #cache = new Map<string, Promise<GameModule>>();
  readonly #defaultId: string | undefined;

  constructor(defaultId?: string) {
    if (defaultId !== undefined) {
      this.#defaultId = assertGameId(defaultId);
    }
  }

  register(id: string, loader: GameModuleLoader): void {
    const gameId = assertGameId(id);
    this.#loaders.set(gameId, loader);
    this.#cache.delete(gameId);
  }

  has(id: string): boolean {
    return this.#loaders.has(assertGameId(id));
  }

  ids(): string[] {
    return [...this.#loaders.keys()];
  }

  /**
   * Loads `id`, or the default when `id` is omitted. Does not catch a throw
   * from the caller: an unknown or invalid id rejects before any loader runs.
   */
  async load(id?: string): Promise<GameModule> {
    const gameId = id === undefined ? this.#defaultId : assertGameId(id);
    if (gameId === undefined) {
      throw new GameModuleError(
        "game.unknown",
        "No game module was requested and this registry has no default.",
        "Pass a game id or construct the registry with a default id.",
      );
    }
    const loader = this.#loaders.get(gameId);
    if (!loader) {
      const known = this.ids().join(", ") || "(none)";
      throw new GameModuleError(
        "game.unknown",
        `Unknown game module "${gameId}".`,
        `Use one of: ${known}.`,
      );
    }
    const cached = this.#cache.get(gameId);
    if (cached) return cached;

    const pending = Promise.resolve()
      .then(() => loader())
      .then((loaded) => {
        if (!isGameModule(loaded) || loaded.id !== gameId) {
          throw new GameModuleError(
            "game.invalidModule",
            `Loader for "${gameId}" did not return a module with that id.`,
            "Return { id, registerScripts } and keep id equal to the registered id.",
          );
        }
        return loaded;
      });
    this.#cache.set(gameId, pending);
    try {
      return await pending;
    } catch (error) {
      this.#cache.delete(gameId);
      if (error instanceof GameModuleError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GameModuleError(
        "game.loadFailed",
        `Failed to load game module "${gameId}": ${message}`,
        "Fix the loader. A failed load is not cached, so the next call tries again.",
      );
    }
  }
}
