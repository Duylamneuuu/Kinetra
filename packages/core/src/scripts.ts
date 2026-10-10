/** Readable text for a thrown value; an Error with an empty message still names its type. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  return String(err);
}

export interface GameScriptInputReader {
  getAction(actionId: string): number;
  isPressed(actionId: string): boolean;
}

export interface GameScriptTransform {
  getPosition(): [number, number, number];
  setPosition(position: [number, number, number]): void;
  translate(delta: [number, number, number]): void;
}

export interface GameScriptSceneQuery {
  getEntityTransform(entityId: string): [number, number, number] | undefined;
  findEntityByName?(name: string): { entityId: string; name: string } | undefined;
}

export interface GameScriptNavigationService {
  computePath(
    start: [number, number, number],
    end: [number, number, number],
    halfExtents?: [number, number, number],
  ): {
    success: boolean;
    status: "complete" | "failed" | "partial";
    pointCount: number;
    points: Array<[number, number, number]>;
  };
  closestPoint?(
    position: [number, number, number],
    halfExtents?: [number, number, number],
  ): [number, number, number];
}

export interface GameScriptAudioService {
  play(options: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<{ success: boolean; playbackId?: string; error?: string }>;
}

export interface GameScriptAnimationGraphService {
  init?(graph: unknown): { success: boolean; error?: string };
  set?(name: string, value: boolean | number): boolean;
  setParameter?(name: string, value: boolean | number): boolean;
  trigger?(name: string): boolean;
  evaluate?(): unknown;
  readonly state?: string | undefined;
  readonly transitioning?: boolean | undefined;
  readonly blendProgress?: number | undefined;
}

export interface GameScriptAnimationService {
  play(clipName: string, options?: { loop?: boolean }): boolean;
  stop(): void;
  /** Sets morph-target weights by name (all-or-nothing, each in [0, 1]). */
  setMorphWeights?(weights: Record<string, number>): boolean;
  /** Clears morph overrides (all when `names` is omitted), restoring authored weights. */
  clearMorphWeights?(names?: string[]): boolean;
  readonly activeClip?: string | undefined;
  readonly playing?: boolean | undefined;
  readonly graph?: GameScriptAnimationGraphService | undefined;
}

export interface GameScriptContext {
  readonly entityId: string;
  readonly sceneId: string;
  readonly input?: GameScriptInputReader;
  readonly transform?: GameScriptTransform;
  readonly scene?: GameScriptSceneQuery;
  readonly navigation?: GameScriptNavigationService;
  readonly audio?: GameScriptAudioService;
  readonly animation?: GameScriptAnimationService;
  emit?(event: string, payload?: unknown): void;
  log?(level: "debug" | "info" | "warning" | "error", category: string, data?: Record<string, unknown>): void;
}

export interface PreparedScriptRestore {
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

export interface GameScript {
  onCreate?(context: GameScriptContext): void | Promise<void>;
  onStart?(context: GameScriptContext): void | Promise<void>;
  onUpdate?(context: GameScriptContext, deltaSeconds: number): void;
  onEvent?(event: string, payload?: unknown, context?: GameScriptContext): void;
  onStop?(context: GameScriptContext): void | Promise<void>;
  onDestroy?(context: GameScriptContext): void | Promise<void>;
  getState?(): Record<string, unknown>;
  validateRestoreState?(
    state: Record<string, unknown>,
    context?: GameScriptContext,
  ): boolean | { valid: boolean; error?: string };
  prepareRestoreState?(
    state: Record<string, unknown>,
    context?: GameScriptContext,
  ): PreparedScriptRestore | Promise<PreparedScriptRestore>;
  restoreState?(state: Record<string, unknown>, context?: GameScriptContext): void | Promise<void>;
}

export type ScriptLifecycleState =
  | "unloaded"
  | "registered"
  | "created"
  | "started"
  | "stopped"
  | "destroyed"
  | "error";

export interface ScriptExecutionState {
  readonly id: string;
  readonly entityId: string;
  readonly scriptId?: string;
  readonly lifecycleState: ScriptLifecycleState;
  readonly updateCount: number;
  readonly created?: boolean;
  readonly started?: boolean;
  readonly stopped?: boolean;
  readonly destroyed?: boolean;
  readonly state?: Record<string, unknown>;
  readonly error?: string;
}

export type GameScriptFactory = (context: GameScriptContext) => GameScript;

export interface ScriptResolver {
  resolve(scriptId: string): GameScriptFactory | undefined;
}

export class ScriptRegistry implements ScriptResolver {
  #factories = new Map<string, GameScriptFactory>();

  register(scriptId: string, factory: GameScriptFactory): void {
    this.#factories.set(scriptId, factory);
  }

  resolve(scriptId: string): GameScriptFactory | undefined {
    return this.#factories.get(scriptId);
  }

  has(scriptId: string): boolean {
    return this.#factories.has(scriptId);
  }
}

interface ScriptEntry {
  id: string;
  scriptId?: string;
  order: number;
  context: GameScriptContext;
  script: GameScript;
  lifecycleState: ScriptLifecycleState;
  updateCount: number;
  created: boolean;
  started: boolean;
  stopped: boolean;
  destroyed: boolean;
  error?: string;
}

export class ScriptHost {
  #entries = new Map<string, ScriptEntry>();
  #inFlight = new Map<"start" | "stop" | "destroy", Promise<void>>();

  register(input: {
    id: string;
    scriptId?: string;
    order?: number;
    context: GameScriptContext;
    script: GameScript;
  }): void {
    if (this.#entries.has(input.id)) {
      throw new Error(`Script "${input.id}" already registered`);
    }
    if (input.order !== undefined && !Number.isFinite(input.order)) {
      // NaN makes the sort comparator inconsistent, so execution order would become engine-defined.
      throw new RangeError(`Script "${input.id}" order must be a finite number`);
    }
    this.#entries.set(input.id, {
      id: input.id,
      ...(input.scriptId ? { scriptId: input.scriptId } : {}),
      order: input.order ?? 0,
      context: input.context,
      script: input.script,
      lifecycleState: "registered",
      updateCount: 0,
      created: false,
      started: false,
      stopped: false,
      destroyed: false,
    });
  }

  /**
   * Creates and starts every registered script. A call made while another startAll() is still
   * awaiting a script hook shares that run instead of starting a second pass, which would
   * otherwise call onCreate/onStart twice for the same script (e.g. a double-clicked Start).
   */
  startAll(): Promise<void> {
    return this.#shared("start", () => this.#startAll());
  }

  /** Stops every started script (reverse order); overlapping calls share one pass. */
  stopAll(): Promise<void> {
    return this.#shared("stop", () => this.#stopAll());
  }

  /** Stops then destroys every script; overlapping calls share one pass. */
  destroyAll(): Promise<void> {
    return this.#shared("destroy", () => this.#destroyAll());
  }

  #shared(pass: "start" | "stop" | "destroy", run: () => Promise<void>): Promise<void> {
    const running = this.#inFlight.get(pass);
    if (running) return running;
    const next = run().finally(() => {
      this.#inFlight.delete(pass);
    });
    this.#inFlight.set(pass, next);
    return next;
  }

  async #startAll(): Promise<void> {
    for (const entry of this.#ordered()) {
      if (entry.lifecycleState === "error") continue;

      if (entry.lifecycleState === "registered") {
        try {
          await entry.script.onCreate?.(entry.context);
          entry.created = true;
          entry.lifecycleState = "created";
        } catch (err) {
          entry.lifecycleState = "error";
          entry.error = errorText(err);
          entry.context.log?.("error", "script.error", {
            id: entry.id,
            scriptId: entry.scriptId,
            phase: "onCreate",
            error: entry.error,
          });
          continue;
        }
      }

      if (entry.lifecycleState === "created") {
        try {
          await entry.script.onStart?.(entry.context);
          entry.started = true;
          entry.lifecycleState = "started";
        } catch (err) {
          entry.lifecycleState = "error";
          entry.error = errorText(err);
          entry.context.log?.("error", "script.error", {
            id: entry.id,
            scriptId: entry.scriptId,
            phase: "onStart",
            error: entry.error,
          });
          continue;
        }
      }
    }
  }

  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError("deltaSeconds must be finite and non-negative");
    }
    for (const entry of this.#ordered()) {
      if (entry.lifecycleState === "started") {
        try {
          entry.script.onUpdate?.(entry.context, deltaSeconds);
          entry.updateCount++;
        } catch (err) {
          entry.lifecycleState = "error";
          entry.error = errorText(err);
          entry.context.log?.("error", "script.error", {
            id: entry.id,
            scriptId: entry.scriptId,
            phase: "onUpdate",
            error: entry.error,
          });
        }
      }
    }
  }

  emit(event: string, payload?: unknown): void {
    for (const entry of this.#ordered()) {
      if (entry.lifecycleState === "started") {
        try {
          entry.script.onEvent?.(event, payload, entry.context);
        } catch (err) {
          entry.lifecycleState = "error";
          entry.error = errorText(err);
          entry.context.log?.("error", "script.error", {
            id: entry.id,
            scriptId: entry.scriptId,
            phase: "onEvent",
            error: entry.error,
          });
        }
      }
    }
  }

  async #stopAll(): Promise<void> {
    for (const entry of this.#ordered().reverse()) {
      // onStop is applicable if onStart successfully completed and onStop has not yet executed
      if (entry.started && !entry.stopped) {
        try {
          await entry.script.onStop?.(entry.context);
          entry.stopped = true;
          if (entry.lifecycleState !== "error") {
            entry.lifecycleState = "stopped";
          }
        } catch (err) {
          entry.stopped = true;
          entry.lifecycleState = "error";
          entry.error = errorText(err);
          entry.context.log?.("error", "script.error", {
            id: entry.id,
            scriptId: entry.scriptId,
            phase: "onStop",
            error: entry.error,
          });
        }
      }
    }
  }

  async #destroyAll(): Promise<void> {
    await this.stopAll();
    for (const entry of this.#ordered().reverse()) {
      // onDestroy is applicable if onCreate successfully completed and onDestroy has not yet executed
      if (entry.created && !entry.destroyed) {
        try {
          await entry.script.onDestroy?.(entry.context);
          entry.destroyed = true;
          if (entry.lifecycleState !== "error") {
            entry.lifecycleState = "destroyed";
          }
        } catch (err) {
          entry.destroyed = true;
          entry.lifecycleState = "error";
          entry.error = errorText(err);
          entry.context.log?.("error", "script.error", {
            id: entry.id,
            scriptId: entry.scriptId,
            phase: "onDestroy",
            error: entry.error,
          });
        }
      }
    }
    this.#entries.clear();
  }

  isCreated(id: string): boolean {
    return this.#entries.get(id)?.created ?? false;
  }

  isStarted(id: string): boolean {
    return this.#entries.get(id)?.started ?? false;
  }

  isStopApplicable(id: string): boolean {
    const entry = this.#entries.get(id);
    return entry ? entry.started && !entry.stopped : false;
  }

  isDestroyApplicable(id: string): boolean {
    const entry = this.#entries.get(id);
    return entry ? entry.created && !entry.destroyed : false;
  }

  getExecutionState(id: string): ScriptExecutionState | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    let state: Record<string, unknown> | undefined;
    if (typeof entry.script.getState === "function") {
      try {
        state = entry.script.getState();
      } catch {
        // preserve robust query
      }
    }
    return {
      id: entry.id,
      entityId: entry.context.entityId,
      ...(entry.scriptId ? { scriptId: entry.scriptId } : {}),
      lifecycleState: entry.lifecycleState,
      updateCount: entry.updateCount,
      created: entry.created,
      started: entry.started,
      stopped: entry.stopped,
      destroyed: entry.destroyed,
      ...(state ? { state } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
  }

  hasScript(id: string): boolean {
    return this.#entries.has(id);
  }

  canRestoreScriptState(id: string): boolean {
    const entry = this.#entries.get(id);
    return (
      !!entry &&
      (typeof entry.script.prepareRestoreState === "function" ||
        typeof entry.script.restoreState === "function")
    );
  }

  canPrepareTransactionalRestore(id: string): boolean {
    const entry = this.#entries.get(id);
    return !!entry && typeof entry.script.prepareRestoreState === "function";
  }

  async prepareScriptRestore(
    id: string,
    state: Record<string, unknown>,
  ): Promise<PreparedScriptRestore> {
    const entry = this.#entries.get(id);
    if (!entry) {
      throw new Error(`Script "${id}" is not registered`);
    }

    if (typeof entry.script.prepareRestoreState === "function") {
      return await entry.script.prepareRestoreState(state, entry.context);
    }

    throw new Error(
      `Script "${id}" does not support transactional state restoration`,
    );
  }

  validateScriptRestoreState(
    id: string,
    state: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    const entry = this.#entries.get(id);
    if (!entry) {
      return { valid: false, error: `Script "${id}" is not registered` };
    }
    if (
      typeof entry.script.prepareRestoreState !== "function" &&
      typeof entry.script.restoreState !== "function"
    ) {
      return {
        valid: false,
        error: `Script "${id}" does not support state restoration`,
      };
    }
    if (typeof entry.script.validateRestoreState === "function") {
      try {
        const result = entry.script.validateRestoreState(state, entry.context);
        if (result instanceof Promise) {
          // Restore validation is a synchronous pre-flight; do not leave a later rejection unhandled.
          (result as Promise<unknown>).catch(() => undefined);
          return {
            valid: false,
            error: `Script "${id}" validateRestoreState must be synchronous`,
          };
        }
        if (typeof result === "boolean") {
          return result
            ? { valid: true }
            : { valid: false, error: `Script "${id}" rejected state payload` };
        }
        if (typeof result === "object" && result !== null) {
          return {
            valid: Boolean(result.valid),
            ...(result.error ? { error: result.error } : {}),
          };
        }
        return {
          valid: false,
          error: `Script "${id}" returned invalid validation response`,
        };
      } catch (err) {
        return {
          valid: false,
          error: errorText(err),
        };
      }
    }
    return { valid: true };
  }

  async restoreScriptState(id: string, state: Record<string, unknown>): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    if (typeof entry.script.prepareRestoreState === "function") {
      const prepared = await entry.script.prepareRestoreState(state, entry.context);
      try {
        await prepared.commit();
      } catch (commitError) {
        // A commit that throws may have half-applied; undo it so the live script is never left torn.
        try {
          await prepared.rollback();
        } catch (rollbackError) {
          const commitMessage =
            commitError instanceof Error ? commitError.message : String(commitError);
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(
            `Script "${id}" restore commit failed (${commitMessage}) and rollback also failed (${rollbackMessage})`,
          );
        }
        throw commitError;
      }
      return true;
    }
    if (typeof entry.script.restoreState === "function") {
      await entry.script.restoreState(state, entry.context);
      return true;
    }
    return false;
  }

  getAllExecutionStates(): ScriptExecutionState[] {
    return [...this.#entries.keys()].map(id => this.getExecutionState(id)!);
  }

  #ordered(): ScriptEntry[] {
    // Code-unit comparison, not localeCompare: execution order must not depend on the host ICU/locale.
    return [...this.#entries.values()].sort(
      (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
}

export class PlayerControllerScript implements GameScript {
  moveCount = 0;
  jumpCount = 0;
  lastAction?: string | undefined;

  onCreate(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", { phase: "onCreate", entityId: context.entityId });
  }

  onStart(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", { phase: "onStart", entityId: context.entityId });
  }

  onUpdate(context: GameScriptContext, _deltaSeconds: number): void {
    const moveRight = context.input?.getAction("player.moveRight") ?? 0;
    if (moveRight > 0) {
      this.moveCount++;
      this.lastAction = "player.moveRight";
      context.transform?.translate([1.0, 0, 0]);
      context.log?.("info", "gameplay.move", {
        entityId: context.entityId,
        moveCount: this.moveCount,
        deltaX: 1.0,
      });
    }

    const jump = context.input?.isPressed("player.jump") ?? false;
    if (jump) {
      this.jumpCount++;
      this.lastAction = "player.jump";
      context.log?.("info", "gameplay.jump", {
        entityId: context.entityId,
        jumpCount: this.jumpCount,
      });
    }
  }

  onStop(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", { phase: "onStop", entityId: context.entityId });
  }

  onDestroy(context: GameScriptContext): void {
    context.log?.("info", "script.lifecycle", { phase: "onDestroy", entityId: context.entityId });
  }

  getState(): Record<string, unknown> {
    return {
      moveCount: this.moveCount,
      jumpCount: this.jumpCount,
      ...(this.lastAction ? { lastAction: this.lastAction } : {}),
    };
  }

  validateRestoreState(
    state: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return { valid: false, error: "Gameplay state must be a non-null object" };
    }
    if ("moveCount" in state) {
      if (typeof state.moveCount !== "number" || !Number.isFinite(state.moveCount)) {
        return { valid: false, error: "moveCount must be a finite number" };
      }
      if (!Number.isSafeInteger(state.moveCount) || state.moveCount < 0) {
        return { valid: false, error: "moveCount must be a non-negative integer" };
      }
    }
    if ("jumpCount" in state) {
      if (typeof state.jumpCount !== "number" || !Number.isFinite(state.jumpCount)) {
        return { valid: false, error: "jumpCount must be a finite number" };
      }
      if (!Number.isSafeInteger(state.jumpCount) || state.jumpCount < 0) {
        return { valid: false, error: "jumpCount must be a non-negative integer" };
      }
    }
    if ("lastAction" in state && state.lastAction !== undefined) {
      if (typeof state.lastAction !== "string") {
        return { valid: false, error: "lastAction must be a string if defined" };
      }
    }
    return { valid: true };
  }

  prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
    const validation = this.validateRestoreState(state);
    if (!validation.valid) {
      throw new Error(
        `Cannot restore invalid PlayerController state: ${validation.error}`,
      );
    }
    const priorMoveCount = this.moveCount;
    const priorJumpCount = this.jumpCount;
    const priorLastAction = this.lastAction;

    const nextMoveCount =
      typeof state.moveCount === "number" ? state.moveCount : this.moveCount;
    const nextJumpCount =
      typeof state.jumpCount === "number" ? state.jumpCount : this.jumpCount;
    const nextLastAction =
      typeof state.lastAction === "string" ? state.lastAction : this.lastAction;

    return {
      commit: () => {
        this.moveCount = nextMoveCount;
        this.jumpCount = nextJumpCount;
        this.lastAction = nextLastAction;
      },
      rollback: () => {
        this.moveCount = priorMoveCount;
        this.jumpCount = priorJumpCount;
        this.lastAction = priorLastAction;
      },
    };
  }

  restoreState(state: Record<string, unknown>): void {
    const prepared = this.prepareRestoreState(state);
    prepared.commit();
  }
}
