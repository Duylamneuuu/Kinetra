import type { JsonValue, ProjectDocument } from "@kinetra/project-model";

import type { OrbRunRules } from "./authoring.js";
import { ORB_RUN_RULES_COMPONENT, ORB_RUN_SCENE_ID, ORB_RUN_SCRIPT } from "./ids.js";
import { OrbRunRulesError, parseOrbRunRules } from "./scripts.js";

/**
 * Level check: a static analysis of the *authored* Orb Run project (positions,
 * `OrbRunRules`) that says whether the level can be won before anyone plays it.
 *
 * Why it exists: Orb Run is rebalanced and re-laid-out by agents through
 * `entity.patch` / `component.patch`. A patch that moves an orb outside the
 * arena or shrinks the clock below the length of the shortest route silently
 * produces an unwinnable game; this check turns that into structured
 * diagnostics (`code`, `entityId`) an agent can act on, using only project data
 * (no simulation, no Three.js).
 *
 * The time estimate is bracketed on purpose:
 * - `lowerBoundSeconds`: nothing can win faster (straight lines between the
 *   pickup/exit circles, best order). A limit below it is `impossible`.
 * - `playtestSeconds`: what the digital-input playtest bot needs (eight
 *   directions, so octile distance, orb centres, best order, plus the fixed
 *   steps it quantises to). A limit at or above it is provably winnable.
 * - in between the level is `unproven`: possible only by cutting corners or
 *   analogue input, so the check makes no claim.
 */

export type OrbRunLevelCode =
  | "scene_missing"
  | "rules_invalid"
  | "manager_count"
  | "player_count"
  | "exit_count"
  | "no_orbs"
  | "transform_invalid"
  | "orbs_duplicate_position"
  | "player_outside_arena"
  | "orb_outside_arena"
  | "orb_unreachable"
  | "exit_unreachable"
  | "time_impossible"
  | "time_unproven"
  | "time_tight";

export interface OrbRunLevelDiagnostic {
  severity: "error" | "warning";
  code: OrbRunLevelCode;
  message: string;
  entityId?: string;
}

/** `invalid`: the project is not an Orb Run level; the others rank how winnable it is. */
export type OrbRunLevelVerdict = "invalid" | "impossible" | "unproven" | "tight" | "comfortable";

export interface OrbRunLevelRoute {
  /** Orbs in the best visiting order (shortest playtest time). */
  orbIds: string[];
  /** Orb centres (clamped into the arena) then the exit centre: what the playtest bot walks to. */
  waypoints: Array<{ x: number; z: number }>;
}

export interface OrbRunLevelReport {
  /** True when there is no error diagnostic (warnings do not fail it). */
  ok: boolean;
  verdict: OrbRunLevelVerdict;
  errorCount: number;
  warningCount: number;
  diagnostics: OrbRunLevelDiagnostic[];
  rules: OrbRunRules | null;
  orbCount: number;
  /** Seconds nothing can beat; null when the level is structurally invalid. */
  lowerBoundSeconds: number | null;
  /** Seconds the playtest bot needs; null when the level is structurally invalid. */
  playtestSeconds: number | null;
  /** `timeLimitSeconds - playtestSeconds` (negative = the bot loses); null when invalid. */
  slackSeconds: number | null;
  /** Whether `route` is the exact optimum (true up to `ORB_RUN_LEVEL_EXACT_ORDER_LIMIT` orbs) or a nearest-neighbour order. */
  orderExact: boolean;
  route: OrbRunLevelRoute | null;
}

export interface OrbRunLevelOptions {
  sceneId?: string;
  /** The simulation step the playtest bot quantises to. Defaults to 1/30 s. */
  fixedDeltaSeconds?: number;
}

/** Up to this many orbs every visiting order is tried; beyond it the order is greedy. */
export const ORB_RUN_LEVEL_EXACT_ORDER_LIMIT = 8;
/** A winnable level whose bot time uses more than this share of the clock is reported `tight`. */
export const ORB_RUN_LEVEL_TIGHT_SHARE = 0.8;

interface Point {
  x: number;
  z: number;
}

interface Found {
  entityId: string;
  position: Point;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scriptIdOf(components: Record<string, JsonValue>): string | undefined {
  const script = components.Script;
  return isRecord(script) && typeof script.scriptId === "string" ? script.scriptId : undefined;
}

function readPosition(components: Record<string, JsonValue>): Point | undefined {
  const transform = components.Transform;
  if (!isRecord(transform) || !Array.isArray(transform.position) || transform.position.length !== 3) return undefined;
  const [x, , z] = transform.position;
  const y = transform.position[1];
  if (![x, y, z].every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  return { x: x as number, z: z as number };
}

function clampToArena(point: Point, limit: number): Point {
  return { x: Math.max(-limit, Math.min(limit, point.x)), z: Math.max(-limit, Math.min(limit, point.z)) };
}

function euclid(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Length of the shortest path with eight directions (the digital input of the playtest bot). */
function octile(a: Point, b: Point): number {
  const dx = Math.abs(a.x - b.x);
  const dz = Math.abs(a.z - b.z);
  return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2;
}

function permutations(count: number): number[][] {
  const result: number[][] = [];
  const current: number[] = [];
  const used = new Array<boolean>(count).fill(false);
  const visit = (): void => {
    if (current.length === count) {
      result.push([...current]);
      return;
    }
    for (let index = 0; index < count; index += 1) {
      if (used[index]) continue;
      used[index] = true;
      current.push(index);
      visit();
      current.pop();
      used[index] = false;
    }
  };
  visit();
  return result;
}

/** Cheapest visiting order of `count` stops under `cost(order)`; greedy nearest-neighbour past the exact limit. */
function bestOrder(
  count: number,
  cost: (order: number[]) => number,
  leg: (from: number | "start", to: number) => number,
): { order: number[]; exact: boolean } {
  if (count <= ORB_RUN_LEVEL_EXACT_ORDER_LIMIT) {
    let best: number[] = [];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const order of permutations(count)) {
      const value = cost(order);
      if (value < bestCost) {
        bestCost = value;
        best = order;
      }
    }
    return { order: best, exact: true };
  }
  const remaining = new Set(Array.from({ length: count }, (_, index) => index));
  const order: number[] = [];
  let from: number | "start" = "start";
  while (remaining.size > 0) {
    let next = -1;
    let nextCost = Number.POSITIVE_INFINITY;
    for (const candidate of remaining) {
      const value = leg(from, candidate);
      if (value < nextCost) {
        nextCost = value;
        next = candidate;
      }
    }
    order.push(next);
    remaining.delete(next);
    from = next;
  }
  return { order, exact: false };
}

function invalidReport(rules: OrbRunRules | null, diagnostics: OrbRunLevelDiagnostic[], orbCount: number): OrbRunLevelReport {
  return {
    ok: false,
    verdict: "invalid",
    errorCount: diagnostics.filter((entry) => entry.severity === "error").length,
    warningCount: diagnostics.filter((entry) => entry.severity === "warning").length,
    diagnostics,
    rules,
    orbCount,
    lowerBoundSeconds: null,
    playtestSeconds: null,
    slackSeconds: null,
    orderExact: true,
    route: null,
  };
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Analyse the authored Orb Run scene of `project`. Never throws on bad project data: it reports it. */
export function analyzeOrbRunLevel(project: ProjectDocument, options: OrbRunLevelOptions = {}): OrbRunLevelReport {
  const sceneId = options.sceneId ?? ORB_RUN_SCENE_ID;
  const fixedDelta = options.fixedDeltaSeconds ?? 1 / 30;
  const diagnostics: OrbRunLevelDiagnostic[] = [];
  const error = (code: OrbRunLevelCode, message: string, entityId?: string): void => {
    diagnostics.push({ severity: "error", code, message, ...(entityId ? { entityId } : {}) });
  };
  const warn = (code: OrbRunLevelCode, message: string, entityId?: string): void => {
    diagnostics.push({ severity: "warning", code, message, ...(entityId ? { entityId } : {}) });
  };

  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) {
    error("scene_missing", `Scene "${sceneId}" does not exist`);
    return invalidReport(null, diagnostics, 0);
  }

  const managers = scene.entities.filter((entity) => scriptIdOf(entity.components) === ORB_RUN_SCRIPT.manager);
  const players = scene.entities.filter((entity) => scriptIdOf(entity.components) === ORB_RUN_SCRIPT.player);
  const orbs = scene.entities.filter((entity) => scriptIdOf(entity.components) === ORB_RUN_SCRIPT.orb);
  const exits = scene.entities.filter((entity) => entity.name === "Exit");

  let rules: OrbRunRules | null = null;
  if (managers.length !== 1) {
    error("manager_count", `Orb Run needs exactly one ${ORB_RUN_SCRIPT.manager} entity, found ${managers.length}`);
  } else {
    try {
      rules = parseOrbRunRules(managers[0]!.components[ORB_RUN_RULES_COMPONENT]);
    } catch (cause) {
      if (!(cause instanceof OrbRunRulesError)) throw cause;
      for (const issue of cause.issues) {
        error("rules_invalid", `${ORB_RUN_RULES_COMPONENT}.${issue.field}: ${issue.message}`, managers[0]!.id);
      }
    }
  }
  if (players.length !== 1) error("player_count", `Orb Run needs exactly one ${ORB_RUN_SCRIPT.player} entity, found ${players.length}`);
  if (exits.length !== 1) error("exit_count", `Orb Run needs exactly one entity named "Exit", found ${exits.length}`);
  if (orbs.length === 0) error("no_orbs", "The level has no orbs: the exit would unlock at once");

  const locate = (entity: { id: string; components: Record<string, JsonValue> }, label: string): Found | undefined => {
    const position = readPosition(entity.components);
    if (!position) {
      error("transform_invalid", `${label} has no finite Transform.position`, entity.id);
      return undefined;
    }
    return { entityId: entity.id, position };
  };
  const player = players.length === 1 ? locate(players[0]!, "Player") : undefined;
  const exit = exits.length === 1 ? locate(exits[0]!, "Exit") : undefined;
  const orbPositions = orbs.map((orb) => locate(orb, `Orb ${orb.id}`));

  if (!rules || !player || !exit || orbs.length === 0 || orbPositions.some((entry) => !entry)) {
    return invalidReport(rules, diagnostics, orbs.length);
  }
  const found = orbPositions as Found[];
  const limit = rules.arenaHalfExtent;

  if (Math.abs(player.position.x) > limit || Math.abs(player.position.z) > limit) {
    warn("player_outside_arena", "The player starts outside the arena and is clamped onto its edge at the first move", player.entityId);
  }
  const start = clampToArena(player.position, limit);

  const seen = new Map<string, string>();
  for (const orb of found) {
    const key = `${orb.position.x},${orb.position.z}`;
    const first = seen.get(key);
    if (first) warn("orbs_duplicate_position", `Orb ${orb.entityId} sits exactly on orb ${first}`, orb.entityId);
    else seen.set(key, orb.entityId);
    const target = clampToArena(orb.position, limit);
    const gap = euclid(orb.position, target);
    if (gap > rules.pickupRadius) {
      error("orb_unreachable", `Orb ${orb.entityId} is ${round(gap)} m outside the arena, further than the pickup radius ${rules.pickupRadius}`, orb.entityId);
    } else if (gap > 0) {
      warn("orb_outside_arena", `Orb ${orb.entityId} is outside the arena and can only be picked up at the edge`, orb.entityId);
    }
  }
  {
    const target = clampToArena(exit.position, limit);
    const gap = euclid(exit.position, target);
    if (gap > rules.exitRadius) {
      error("exit_unreachable", `The exit is ${round(gap)} m outside the arena, further than the exit radius ${rules.exitRadius}`, exit.entityId);
    }
  }
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return invalidReport(rules, diagnostics, orbs.length);
  }

  const targets = found.map((orb) => clampToArena(orb.position, limit));
  const exitTarget = clampToArena(exit.position, limit);
  const radius = rules.pickupRadius;

  // Lower bound: Euclidean legs between the pickup circles and the exit circle.
  const lowerLeg = (from: number | "start", to: number): number =>
    Math.max(0, euclid(from === "start" ? start : found[from]!.position, found[to]!.position) - radius - (from === "start" ? 0 : radius));
  const lowerCost = (order: number[]): number => {
    let total = 0;
    let from: number | "start" = "start";
    for (const index of order) {
      total += lowerLeg(from, index);
      from = index;
    }
    const last = from === "start" ? start : found[from]!.position;
    return total + Math.max(0, euclid(last, exit.position) - (from === "start" ? 0 : radius) - rules.exitRadius);
  };
  // Playtest: octile legs between the (clamped) centres.
  const playLeg = (from: number | "start", to: number): number =>
    octile(from === "start" ? start : targets[from]!, targets[to]!);
  const playCost = (order: number[]): number => {
    let total = 0;
    let from: number | "start" = "start";
    for (const index of order) {
      total += playLeg(from, index);
      from = index;
    }
    return total + octile(from === "start" ? start : targets[from]!, exitTarget);
  };

  const lower = bestOrder(found.length, lowerCost, lowerLeg);
  const play = bestOrder(found.length, playCost, playLeg);
  const lowerBoundSeconds = lowerCost(lower.order) / rules.playerSpeed;
  // One fixed step of quantisation per leg, plus the step on which the manager sees the final position.
  const legs = found.length + 1;
  const playtestSeconds = playCost(play.order) / rules.playerSpeed + (legs + 1) * fixedDelta;
  const slackSeconds = rules.timeLimitSeconds - playtestSeconds;

  let verdict: OrbRunLevelVerdict;
  if (lowerBoundSeconds >= rules.timeLimitSeconds) {
    verdict = "impossible";
    error(
      "time_impossible",
      `The clock (${rules.timeLimitSeconds} s) is shorter than the fastest conceivable run (${round(lowerBoundSeconds)} s)`,
      managers[0]!.id,
    );
  } else if (playtestSeconds > rules.timeLimitSeconds) {
    verdict = "unproven";
    warn(
      "time_unproven",
      `The playtest bot needs ${round(playtestSeconds)} s against a ${rules.timeLimitSeconds} s clock; only corner-cutting could win (lower bound ${round(lowerBoundSeconds)} s)`,
      managers[0]!.id,
    );
  } else if (playtestSeconds > rules.timeLimitSeconds * ORB_RUN_LEVEL_TIGHT_SHARE) {
    verdict = "tight";
    warn(
      "time_tight",
      `The playtest bot uses ${round((playtestSeconds / rules.timeLimitSeconds) * 100)}% of the clock (${round(slackSeconds)} s to spare)`,
      managers[0]!.id,
    );
  } else {
    verdict = "comfortable";
  }

  const errorCount = diagnostics.filter((entry) => entry.severity === "error").length;
  return {
    ok: errorCount === 0,
    verdict,
    errorCount,
    warningCount: diagnostics.length - errorCount,
    diagnostics,
    rules,
    orbCount: found.length,
    lowerBoundSeconds: round(lowerBoundSeconds),
    playtestSeconds: round(playtestSeconds),
    slackSeconds: round(slackSeconds),
    orderExact: play.exact && lower.exact,
    route: {
      orbIds: play.order.map((index) => found[index]!.entityId),
      waypoints: [...play.order.map((index) => targets[index]!), exitTarget].map((point) => ({ x: point.x, z: point.z })),
    },
  };
}
