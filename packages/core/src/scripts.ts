export interface GameScriptInputReader {
  getAction(actionId: string): number;
  isPressed(actionId: string): boolean;
}

export interface GameScriptTransform {
  getPosition(): [number, number, number];
  setPosition(position: [number, number, number]): void;
  translate(delta: [number, number, number]): void;
}

export interface GameScriptContext {
  readonly entityId: string;
  readonly sceneId: string;
  readonly input?: GameScriptInputReader;
  readonly transform?: GameScriptTransform;
  log?(level: "debug" | "info" | "warning" | "error", category: string, data?: Record<string, unknown>): void;
}

export interface GameScript {
  onCreate?(context: GameScriptContext): void | Promise<void>;
  onStart?(context: GameScriptContext): void | Promise<void>;
  onUpdate?(context: GameScriptContext, deltaSeconds: number): void;
  onStop?(context: GameScriptContext): void | Promise<void>;
  onDestroy?(context: GameScriptContext): void | Promise<void>;
  getState?(): Record<string, unknown>;
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
  error?: string;
}

export class ScriptHost {
  #entries = new Map<string, ScriptEntry>();

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
    this.#entries.set(input.id, {
      id: input.id,
      ...(input.scriptId ? { scriptId: input.scriptId } : {}),
      order: input.order ?? 0,
      context: input.context,
      script: input.script,
      lifecycleState: "registered",
      updateCount: 0,
    });
  }

  async startAll(): Promise<void> {
    for (const entry of this.#ordered()) {
      if (entry.lifecycleState === "error") continue;
      try {
        if (entry.lifecycleState === "registered") {
          await entry.script.onCreate?.(entry.context);
          entry.lifecycleState = "created";
        }
        if (entry.lifecycleState === "created") {
          await entry.script.onStart?.(entry.context);
          entry.lifecycleState = "started";
        }
      } catch (err) {
        entry.lifecycleState = "error";
        entry.error = err instanceof Error ? err.message : String(err);
        entry.context.log?.("error", "script.error", {
          id: entry.id,
          scriptId: entry.scriptId,
          phase: "onStart",
          error: entry.error,
        });
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
          entry.error = err instanceof Error ? err.message : String(err);
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

  async stopAll(): Promise<void> {
    for (const entry of this.#ordered().reverse()) {
      if (entry.lifecycleState === "started") {
        try {
          await entry.script.onStop?.(entry.context);
          entry.lifecycleState = "stopped";
        } catch (err) {
          entry.lifecycleState = "error";
          entry.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
  }

  async destroyAll(): Promise<void> {
    await this.stopAll();
    for (const entry of this.#ordered().reverse()) {
      if (entry.lifecycleState === "stopped" || entry.lifecycleState === "created") {
        try {
          await entry.script.onDestroy?.(entry.context);
          entry.lifecycleState = "destroyed";
        } catch (err) {
          entry.lifecycleState = "error";
          entry.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    this.#entries.clear();
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
      ...(state ? { state } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  getAllExecutionStates(): ScriptExecutionState[] {
    return [...this.#entries.keys()].map(id => this.getExecutionState(id)!);
  }

  #ordered(): ScriptEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
}

export class PlayerControllerScript implements GameScript {
  moveCount = 0;
  jumpCount = 0;
  lastAction?: string;

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
}
