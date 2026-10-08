import {
  ScriptRegistry,
  type GameScript,
  type GameScriptContext,
  type PreparedScriptRestore,
} from "@kinetra/core";
import type { JsonValue, ProjectDocument } from "@kinetra/project-model";

import { ORB_RUN_DEFAULT_RULES, type OrbRunRules } from "./authoring.js";
import {
  ORB_RUN_ACTION,
  ORB_RUN_EVENT,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCRIPT,
} from "./ids.js";

type Vec3 = [number, number, number];

const HIDDEN_Y = -10;

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validity(error?: string): { valid: boolean; error?: string } {
  return error ? { valid: false, error } : { valid: true };
}

export interface OrbRunRulesIssue {
  field: keyof OrbRunRules | "component";
  message: string;
}

export class OrbRunRulesError extends Error {
  readonly code = "ORB_RUN_RULES_INVALID";
  readonly issues: OrbRunRulesIssue[];
  constructor(issues: OrbRunRulesIssue[]) {
    super(`OrbRunRules invalid: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`);
    this.issues = issues;
  }
}

/** Validate authored `OrbRunRules` data; throws `OrbRunRulesError` with every issue. */
export function parseOrbRunRules(value: JsonValue | undefined): OrbRunRules {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OrbRunRulesError([{ field: "component", message: "OrbRunRules component must be an object" }]);
  }
  const record = value as Record<string, unknown>;
  const issues: OrbRunRulesIssue[] = [];
  const rules = { ...ORB_RUN_DEFAULT_RULES };
  for (const field of Object.keys(ORB_RUN_DEFAULT_RULES) as Array<keyof OrbRunRules>) {
    const candidate = record[field];
    if (candidate === undefined) continue;
    if (!isFiniteNumber(candidate) || candidate <= 0) {
      issues.push({ field, message: "must be a finite number > 0" });
      continue;
    }
    rules[field] = candidate;
  }
  if (issues.length > 0) throw new OrbRunRulesError(issues);
  return rules;
}

export class OrbRunPlayer implements GameScript {
  distanceTravelled = 0;
  finished = false;

  constructor(private readonly rules: OrbRunRules) {}

  onUpdate(context: GameScriptContext, deltaSeconds: number): void {
    if (this.finished || !context.transform || !context.input) return;
    const input = context.input;
    let dx = 0;
    let dz = 0;
    if (input.getAction(ORB_RUN_ACTION.moveRight) > 0) dx += 1;
    if (input.getAction(ORB_RUN_ACTION.moveLeft) > 0) dx -= 1;
    if (input.getAction(ORB_RUN_ACTION.moveBackward) > 0) dz += 1;
    if (input.getAction(ORB_RUN_ACTION.moveForward) > 0) dz -= 1;
    if (dx === 0 && dz === 0) return;

    const length = Math.hypot(dx, dz);
    const step = this.rules.playerSpeed * deltaSeconds;
    const before = context.transform.getPosition();
    const limit = this.rules.arenaHalfExtent;
    const next: Vec3 = [
      Math.max(-limit, Math.min(limit, before[0] + (dx / length) * step)),
      before[1],
      Math.max(-limit, Math.min(limit, before[2] + (dz / length) * step)),
    ];
    context.transform.setPosition(next);
    this.distanceTravelled += horizontalDistance(before, next);
  }

  onEvent(event: string): void {
    if (event === ORB_RUN_EVENT.won || event === ORB_RUN_EVENT.lost) this.finished = true;
  }

  getState(): Record<string, unknown> {
    return { distanceTravelled: this.distanceTravelled, finished: this.finished };
  }

  validateRestoreState(state: Record<string, unknown>): { valid: boolean; error?: string } {
    if (!isFiniteNumber(state.distanceTravelled) || state.distanceTravelled < 0) {
      return validity("distanceTravelled must be a finite number >= 0");
    }
    if (typeof state.finished !== "boolean") return validity("finished must be a boolean");
    return validity();
  }

  prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
    const previous = { distanceTravelled: this.distanceTravelled, finished: this.finished };
    return {
      commit: () => {
        this.distanceTravelled = state.distanceTravelled as number;
        this.finished = state.finished as boolean;
      },
      rollback: () => {
        this.distanceTravelled = previous.distanceTravelled;
        this.finished = previous.finished;
      },
    };
  }
}

export class OrbRunOrb implements GameScript {
  collected = false;
  #playerId: string | undefined;

  constructor(private readonly rules: OrbRunRules) {}

  onStart(context: GameScriptContext): void {
    this.#playerId = context.scene?.findEntityByName?.("Player")?.entityId;
    if (!this.#playerId) {
      context.log?.("error", "orbRun.playerMissing", { entityId: context.entityId });
    }
  }

  onUpdate(context: GameScriptContext): void {
    if (this.collected || !this.#playerId || !context.transform) return;
    const player = context.scene?.getEntityTransform(this.#playerId);
    if (!player) return;
    const own = context.transform.getPosition();
    if (horizontalDistance(own, player) > this.rules.pickupRadius) return;
    this.collected = true;
    context.transform.setPosition([own[0], HIDDEN_Y, own[2]]);
    context.log?.("info", "orbRun.orbCollected", { orbId: context.entityId });
    context.emit?.(ORB_RUN_EVENT.orbCollected, { orbId: context.entityId });
  }

  getState(): Record<string, unknown> {
    return { collected: this.collected };
  }

  validateRestoreState(state: Record<string, unknown>): { valid: boolean; error?: string } {
    return typeof state.collected === "boolean" ? validity() : validity("collected must be a boolean");
  }

  prepareRestoreState(state: Record<string, unknown>, context?: GameScriptContext): PreparedScriptRestore {
    const previous = this.collected;
    const previousPosition = context?.transform?.getPosition();
    return {
      commit: () => {
        this.collected = state.collected as boolean;
        if (this.collected && context?.transform && previousPosition) {
          context.transform.setPosition([previousPosition[0], HIDDEN_Y, previousPosition[2]]);
        }
      },
      rollback: () => {
        this.collected = previous;
        if (context?.transform && previousPosition) context.transform.setPosition(previousPosition);
      },
    };
  }
}

export type OrbRunStatus = "playing" | "won" | "lost";

export interface OrbRunManagerConfig {
  rules: OrbRunRules;
  orbIds: readonly string[];
  exitEntityName: string;
  playerEntityName: string;
}

export class OrbRunManager implements GameScript {
  status: OrbRunStatus = "playing";
  collectedOrbIds = new Set<string>();
  exitUnlocked = false;
  elapsedSeconds = 0;
  #playerId: string | undefined;
  #exitId: string | undefined;

  constructor(private readonly config: OrbRunManagerConfig) {}

  get totalOrbs(): number {
    return this.config.orbIds.length;
  }

  onStart(context: GameScriptContext): void {
    this.#playerId = context.scene?.findEntityByName?.(this.config.playerEntityName)?.entityId;
    this.#exitId = context.scene?.findEntityByName?.(this.config.exitEntityName)?.entityId;
    context.log?.("info", "orbRun.started", {
      totalOrbs: this.totalOrbs,
      timeLimitSeconds: this.config.rules.timeLimitSeconds,
      playerFound: this.#playerId !== undefined,
      exitFound: this.#exitId !== undefined,
    });
  }

  onUpdate(context: GameScriptContext, deltaSeconds: number): void {
    if (this.status !== "playing") return;
    this.elapsedSeconds += deltaSeconds;

    if (!this.exitUnlocked && this.collectedOrbIds.size === this.totalOrbs) {
      this.exitUnlocked = true;
      context.log?.("info", "orbRun.exitUnlocked", { elapsedSeconds: this.elapsedSeconds });
      context.emit?.(ORB_RUN_EVENT.exitUnlocked, { elapsedSeconds: this.elapsedSeconds });
    }

    if (this.exitUnlocked && this.#playerId && this.#exitId) {
      const player = context.scene?.getEntityTransform(this.#playerId);
      const exit = context.scene?.getEntityTransform(this.#exitId);
      if (player && exit && horizontalDistance(player, exit) <= this.config.rules.exitRadius) {
        this.#finish(context, "won");
        return;
      }
    }

    if (this.elapsedSeconds >= this.config.rules.timeLimitSeconds) {
      this.#finish(context, "lost");
    }
  }

  onEvent(event: string, payload?: unknown): void {
    if (event !== ORB_RUN_EVENT.orbCollected || this.status !== "playing") return;
    const orbId =
      typeof payload === "object" && payload !== null && "orbId" in payload
        ? (payload as { orbId: unknown }).orbId
        : undefined;
    if (typeof orbId === "string" && this.config.orbIds.includes(orbId)) {
      this.collectedOrbIds.add(orbId);
    }
  }

  getState(): Record<string, unknown> {
    return {
      status: this.status,
      collectedOrbIds: [...this.collectedOrbIds].sort(),
      collectedCount: this.collectedOrbIds.size,
      totalOrbs: this.totalOrbs,
      exitUnlocked: this.exitUnlocked,
      elapsedSeconds: this.elapsedSeconds,
      remainingSeconds: Math.max(0, this.config.rules.timeLimitSeconds - this.elapsedSeconds),
    };
  }

  validateRestoreState(state: Record<string, unknown>): { valid: boolean; error?: string } {
    if (state.status !== "playing" && state.status !== "won" && state.status !== "lost") {
      return validity('status must be "playing", "won" or "lost"');
    }
    if (!Array.isArray(state.collectedOrbIds)) return validity("collectedOrbIds must be an array");
    for (const id of state.collectedOrbIds) {
      if (typeof id !== "string" || !this.config.orbIds.includes(id)) {
        return validity(`collectedOrbIds contains unknown orb "${String(id)}"`);
      }
    }
    if (new Set(state.collectedOrbIds).size !== state.collectedOrbIds.length) {
      return validity("collectedOrbIds must not repeat");
    }
    if (typeof state.exitUnlocked !== "boolean") return validity("exitUnlocked must be a boolean");
    if (state.exitUnlocked && state.collectedOrbIds.length !== this.totalOrbs) {
      return validity("exitUnlocked requires every orb collected");
    }
    if (!isFiniteNumber(state.elapsedSeconds) || state.elapsedSeconds < 0) {
      return validity("elapsedSeconds must be a finite number >= 0");
    }
    return validity();
  }

  prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
    const previous = this.getState();
    const apply = (source: Record<string, unknown>) => {
      this.status = source.status as OrbRunStatus;
      this.collectedOrbIds = new Set(source.collectedOrbIds as string[]);
      this.exitUnlocked = source.exitUnlocked as boolean;
      this.elapsedSeconds = source.elapsedSeconds as number;
    };
    return { commit: () => apply(state), rollback: () => apply(previous) };
  }

  #finish(context: GameScriptContext, status: "won" | "lost"): void {
    this.status = status;
    const summary = {
      collectedCount: this.collectedOrbIds.size,
      totalOrbs: this.totalOrbs,
      elapsedSeconds: this.elapsedSeconds,
    };
    context.log?.("info", status === "won" ? "orbRun.won" : "orbRun.lost", summary);
    context.emit?.(status === "won" ? ORB_RUN_EVENT.won : ORB_RUN_EVENT.lost, summary);
  }
}

/**
 * Build the script registry for an authored Orb Run project. Scripts cannot
 * read authored component data through `GameScriptContext`, so the factories
 * read `OrbRunRules` and the orb list from the project up front.
 */
export function createOrbRunScriptRegistry(project: ProjectDocument, sceneId: string): ScriptRegistry {
  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`Scene "${sceneId}" does not exist`);

  const scriptIdOf = (components: Record<string, JsonValue>): string | undefined => {
    const script = components.Script;
    return typeof script === "object" && script !== null && !Array.isArray(script) && typeof script.scriptId === "string"
      ? script.scriptId
      : undefined;
  };

  const managers = scene.entities.filter((entity) => scriptIdOf(entity.components) === ORB_RUN_SCRIPT.manager);
  if (managers.length !== 1) {
    throw new Error(`Orb Run needs exactly one ${ORB_RUN_SCRIPT.manager} entity, found ${managers.length}`);
  }
  const rules = parseOrbRunRules(managers[0]!.components[ORB_RUN_RULES_COMPONENT]);
  const orbIds = scene.entities
    .filter((entity) => scriptIdOf(entity.components) === ORB_RUN_SCRIPT.orb)
    .map((entity) => entity.id)
    .sort();

  const registry = new ScriptRegistry();
  registry.register(ORB_RUN_SCRIPT.player, () => new OrbRunPlayer(rules));
  registry.register(ORB_RUN_SCRIPT.orb, () => new OrbRunOrb(rules));
  registry.register(
    ORB_RUN_SCRIPT.manager,
    () => new OrbRunManager({ rules, orbIds, exitEntityName: "Exit", playerEntityName: "Player" }),
  );
  return registry;
}
