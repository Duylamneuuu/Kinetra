import {
  ScriptHost,
  type GameScriptContext,
  type ScriptExecutionState,
  type ScriptResolver,
} from "@kinetra/core";
import {
  assertValidProject,
  cloneProject,
  type EntityDefinition,
  type JsonValue,
  type ProjectDocument,
} from "@kinetra/project-model";

/**
 * Minimal headless simulation for a Kinetra scene.
 *
 * Kinetra has no engine-owned headless world yet (the Electron player binds
 * scripts to THREE.Object3D positions). This harness binds `ScriptHost` to an
 * engine-free runtime transform table seeded from authored `Transform` data so
 * gameplay can be proven deterministically in plain Node. The authoring
 * project is cloned and never mutated: runtime state stays separate from
 * project state. See examples/orb-run/README.md ("Engine requests").
 */

export type Vec3 = [number, number, number];

export interface SimulationLogEntry {
  step: number;
  level: "debug" | "info" | "warning" | "error";
  category: string;
  data?: Record<string, unknown>;
}

export interface SimulationEvent {
  step: number;
  event: string;
  payload?: unknown;
}

export interface HeadlessSimulationOptions {
  project: ProjectDocument;
  sceneId: string;
  scripts: ScriptResolver;
  /** Fixed simulation step in seconds. Defaults to 1/30. */
  fixedDeltaSeconds?: number;
}

export interface UnresolvedScript {
  entityId: string;
  scriptId: string;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function readVec3(value: JsonValue | undefined, fallback: Vec3): Vec3 {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return [...fallback];
}

export class HeadlessSceneSimulation {
  readonly sceneId: string;
  readonly fixedDeltaSeconds: number;
  readonly unresolvedScripts: UnresolvedScript[] = [];

  #project: ProjectDocument;
  #entities: Map<string, EntityDefinition>;
  #positions = new Map<string, Vec3>();
  #actions = new Map<string, number>();
  #host = new ScriptHost();
  #logs: SimulationLogEntry[] = [];
  #events: SimulationEvent[] = [];
  #step = 0;
  #started = false;

  constructor(options: HeadlessSimulationOptions) {
    assertValidProject(options.project);
    this.#project = cloneProject(options.project);
    this.sceneId = options.sceneId;
    this.fixedDeltaSeconds = options.fixedDeltaSeconds ?? 1 / 30;
    if (!Number.isFinite(this.fixedDeltaSeconds) || this.fixedDeltaSeconds <= 0) {
      throw new RangeError("fixedDeltaSeconds must be finite and positive");
    }

    const scene = this.#project.scenes.find((candidate) => candidate.id === options.sceneId);
    if (!scene) {
      throw new Error(`Scene "${options.sceneId}" does not exist in project "${this.#project.projectId}"`);
    }
    this.#entities = new Map(scene.entities.map((entity) => [entity.id, entity]));

    for (const entity of scene.entities) {
      const transform = asRecord(entity.components.Transform);
      if (transform) {
        this.#positions.set(entity.id, readVec3(transform.position, [0, 0, 0]));
      }
    }

    for (const entity of scene.entities) {
      const script = asRecord(entity.components.Script);
      if (!script || typeof script.scriptId !== "string") continue;
      const scriptId = script.scriptId;
      const factory = options.scripts.resolve(scriptId);
      if (!factory) {
        this.unresolvedScripts.push({ entityId: entity.id, scriptId });
        this.#log("error", "script.resolveFailed", { entityId: entity.id, scriptId });
        continue;
      }
      const context = this.#createContext(entity.id);
      this.#host.register({
        id: entity.id,
        scriptId,
        order: typeof script.order === "number" ? script.order : 0,
        context,
        script: factory(context),
      });
    }
  }

  get step(): number {
    return this.#step;
  }

  get elapsedSeconds(): number {
    return this.#step * this.fixedDeltaSeconds;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#host.startAll();
  }

  /** Hold (value > 0) or release (value 0) a semantic input action. */
  setAction(actionId: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Action "${actionId}" value must be finite and >= 0`);
    }
    if (value === 0) this.#actions.delete(actionId);
    else this.#actions.set(actionId, value);
  }

  releaseAllActions(): void {
    this.#actions.clear();
  }

  advance(steps = 1): void {
    if (!this.#started) {
      throw new Error("Simulation must be started before advancing");
    }
    for (let index = 0; index < steps; index += 1) {
      this.#step += 1;
      this.#host.update(this.fixedDeltaSeconds);
    }
  }

  /** Advance until `predicate` is true or `maxSteps` elapse; returns whether it became true. */
  advanceUntil(predicate: () => boolean, maxSteps: number): boolean {
    for (let index = 0; index < maxSteps; index += 1) {
      if (predicate()) return true;
      this.advance(1);
    }
    return predicate();
  }

  getPosition(entityId: string): Vec3 | undefined {
    const position = this.#positions.get(entityId);
    return position ? [...position] : undefined;
  }

  /** Authored (read-only) component data for an entity, as a deep copy. */
  getAuthoredComponent(entityId: string, component: string): JsonValue | undefined {
    const value = this.#entities.get(entityId)?.components[component];
    return value === undefined ? undefined : structuredClone(value);
  }

  scriptState(entityId: string): ScriptExecutionState | undefined {
    return this.#host.getExecutionState(entityId);
  }

  scriptStates(): ScriptExecutionState[] {
    return this.#host.getAllExecutionStates();
  }

  logs(category?: string): SimulationLogEntry[] {
    const entries = category ? this.#logs.filter((entry) => entry.category === category) : this.#logs;
    return structuredClone(entries);
  }

  events(name?: string): SimulationEvent[] {
    const entries = name ? this.#events.filter((entry) => entry.event === name) : this.#events;
    return structuredClone(entries);
  }

  async restoreScript(entityId: string, state: Record<string, unknown>): Promise<void> {
    const validation = this.#host.validateScriptRestoreState(entityId, state);
    if (!validation.valid) {
      throw new Error(validation.error ?? `Script "${entityId}" rejected restore state`);
    }
    await this.#host.restoreScriptState(entityId, state);
  }

  restorePosition(entityId: string, position: Vec3): void {
    if (!this.#positions.has(entityId)) {
      throw new Error(`Entity "${entityId}" has no runtime transform`);
    }
    this.#positions.set(entityId, [...position]);
  }

  async dispose(): Promise<void> {
    await this.#host.destroyAll();
  }

  #log(level: SimulationLogEntry["level"], category: string, data?: Record<string, unknown>): void {
    this.#logs.push({ step: this.#step, level, category, ...(data ? { data: structuredClone(data) } : {}) });
  }

  #createContext(entityId: string): GameScriptContext {
    const positions = this.#positions;
    const ensure = (): Vec3 => {
      let position = positions.get(entityId);
      if (!position) {
        position = [0, 0, 0];
        positions.set(entityId, position);
      }
      return position;
    };
    return {
      entityId,
      sceneId: this.sceneId,
      input: {
        getAction: (actionId) => this.#actions.get(actionId) ?? 0,
        isPressed: (actionId) => (this.#actions.get(actionId) ?? 0) > 0,
      },
      transform: {
        getPosition: () => [...ensure()],
        setPosition: (position) => {
          positions.set(entityId, [...position]);
        },
        translate: (delta) => {
          const current = ensure();
          positions.set(entityId, [current[0] + delta[0], current[1] + delta[1], current[2] + delta[2]]);
        },
      },
      scene: {
        getEntityTransform: (targetId) => {
          const position = positions.get(targetId);
          return position ? [...position] : undefined;
        },
        findEntityByName: (name) => {
          for (const entity of this.#entities.values()) {
            if (entity.name === name) return { entityId: entity.id, name: entity.name };
          }
          return undefined;
        },
      },
      emit: (event, payload) => {
        this.#events.push({ step: this.#step, event, ...(payload !== undefined ? { payload: structuredClone(payload) } : {}) });
        this.#host.emit(event, payload);
      },
      log: (level, category, data) => this.#log(level, category, data),
    };
  }
}
