import type { ProjectDocument } from "@kinetra/project-model";

import { ScriptRegistry } from "./scripts.js";

/**
 * A "game module" is the only thing a runtime host needs to know about a game
 * beyond its authored project data: which script ids the project references,
 * how to build their factories, and (optionally) how to summarise the game's
 * own state for observers.
 *
 * The contract is Three.js-free and does not own any authoring state: the
 * project document stays the source of truth, a module only supplies the code
 * that project data points at.
 */
export interface GameModuleScriptContext {
  readonly project: ProjectDocument;
  readonly sceneId: string;
}

/** Minimal structural view of a runtime entity, enough to summarise game state. */
export interface GameModuleEntityView {
  readonly entityId: string;
  readonly name: string;
  readonly gameplay?: {
    readonly scriptId: string;
    readonly state?: Record<string, unknown> | undefined;
  } | undefined;
}

export interface GameModule {
  /** Stable id used by `runtime.start { game }` and `test.runAcceptance { game }`. */
  readonly id: string;
  /**
   * Register a factory for every script id this game's projects reference.
   * May throw when the project cannot be run by this game (for example a
   * missing manager entity); the host reports that as a structured start error.
   */
  registerScripts(registry: ScriptRegistry, context: GameModuleScriptContext): void;
  /**
   * Optional: reduce the live entities to the game-level state observers read
   * as `state.game`. Return `undefined` when the game has no summary yet.
   * `status` of `"won"` / `"lost"` moves the player shell to its end screens.
   */
  readGameState?(entities: readonly GameModuleEntityView[]): Record<string, unknown> | undefined;
}

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
    super(message);
    this.name = "GameModuleError";
    this.code = code;
    this.remediation = remediation;
  }
}

export type GameModuleLoader = () => GameModule | Promise<GameModule>;

/**
 * Lookup of game modules by id. Loaders are lazy so a host can keep a game's
 * code out of its first-paint bundle until that game is actually requested.
 */
export class GameModuleRegistry {
  readonly #loaders = new Map<string, GameModuleLoader>();
  readonly #loaded = new Map<string, GameModule>();
  readonly #defaultId: string | undefined;

  constructor(options: { defaultId?: string } = {}) {
    this.#defaultId = options.defaultId;
  }

  get defaultId(): string | undefined {
    return this.#defaultId;
  }

  /** Register a loader. Re-registering an id replaces it and drops any cached module. */
  register(id: string, loader: GameModuleLoader): void {
    assertGameId(id);
    this.#loaders.set(id, loader);
    this.#loaded.delete(id);
  }

  has(id: string): boolean {
    return typeof id === "string" && this.#loaders.has(id);
  }

  /** Registered ids in code-point order (locale independent, deterministic). */
  ids(): string[] {
    return [...this.#loaders.keys()].sort(compareCodePoints);
  }

  /**
   * Resolve a module. `undefined` selects the registry default; when there is no
   * default that is an error rather than a silent guess. Never returns a
   * module whose `id` differs from the id it was registered under.
   */
  async load(id?: string): Promise<GameModule> {
    const requested = id ?? this.#defaultId;
    if (requested === undefined) {
      throw new GameModuleError(
        "game.unknown",
        "No game was requested and the host has no default game",
        `Pass one of: ${this.#describeIds()}.`,
      );
    }
    assertGameId(requested);

    const cached = this.#loaded.get(requested);
    if (cached) return cached;

    const loader = this.#loaders.get(requested);
    if (!loader) {
      throw new GameModuleError(
        "game.unknown",
        `Unknown game "${requested}"`,
        `Use one of: ${this.#describeIds()}.`,
      );
    }

    let module: GameModule;
    try {
      module = await loader();
    } catch (error) {
      throw new GameModuleError(
        "game.loadFailed",
        `Game "${requested}" failed to load: ${error instanceof Error ? error.message : String(error)}`,
        "Check that the game package is built and bundled with this player.",
      );
    }

    if (
      typeof module !== "object" ||
      module === null ||
      typeof module.registerScripts !== "function" ||
      module.id !== requested
    ) {
      throw new GameModuleError(
        "game.invalidModule",
        `Game "${requested}" did not return a module with a matching id and a registerScripts function`,
        "Export a GameModule whose id equals the id it is registered under.",
      );
    }

    this.#loaded.set(requested, module);
    return module;
  }

  /**
   * Build a fresh script registry for one start. Scripts the module registers
   * never leak into the next start, and a module that throws is reported as a
   * structured error instead of an unhandled exception.
   */
  async createScriptRegistry(
    id: string | undefined,
    context: GameModuleScriptContext,
  ): Promise<{ module: GameModule; registry: ScriptRegistry }> {
    const module = await this.load(id);
    const registry = new ScriptRegistry();
    try {
      module.registerScripts(registry, context);
    } catch (error) {
      throw new GameModuleError(
        "game.registerFailed",
        `Game "${module.id}" could not register scripts for scene "${context.sceneId}": ${error instanceof Error ? error.message : String(error)}`,
        "Start a project authored for this game, or pick the game that matches the project.",
      );
    }
    return { module, registry };
  }

  #describeIds(): string {
    const ids = this.ids();
    return ids.length > 0 ? ids.map((entry) => `"${entry}"`).join(", ") : "(none registered)";
  }
}

function assertGameId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new GameModuleError(
      "game.invalidId",
      `Game id ${typeof id === "string" ? JSON.stringify(id.slice(0, 80)) : String(id)} is not valid`,
      "Game ids are 1-64 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.",
    );
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
