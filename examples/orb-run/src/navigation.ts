import { RecastNavMesh } from "@kinetra/navigation-recast";
import type { ProjectDocument } from "@kinetra/project-model";

import { ORB_RUN_ENTITY, ORB_RUN_SCENE_ID, ORB_RUN_SCRIPT } from "./ids.js";
import { OrbRunHeadlessProbe, type OrbRunHeadlessProbeOptions } from "./acceptance-probe.js";
import { analyzeOrbRunLevel, type OrbRunLevelDiagnostic } from "./level-check.js";
import { walkStraightTo } from "./game.js";
import { readOrbRunWalls, type OrbRunWall } from "./walls.js";
import type { HeadlessSceneSimulation } from "./simulation.js";

/**
 * Navigation: Orb Run routes through its walls with the engine's own
 * `@kinetra/navigation-recast`. `planOrbRunRoute(project)` bakes a navmesh from
 * the authored level (arena floor + every `OrbRunWall`), finds the shortest
 * walkable path between the player, every orb and the exit, picks the best
 * visiting order, and returns a plan a bot can follow (`followOrbRunRoute`).
 *
 * Node-only on purpose (it loads Recast's WASM): like `acceptance-suite.ts`
 * this module is not exported from the package entry that web bundles read.
 */

export type OrbRunRouteCode = "level_invalid" | "route_blocked" | "navmesh_error";

export interface OrbRunRouteDiagnostic {
  severity: "error" | "warning";
  code: OrbRunRouteCode;
  message: string;
  entityId?: string;
}

export interface OrbRunRoutePoint {
  x: number;
  z: number;
}

export interface OrbRunRouteLeg {
  /** Entity id the leg ends at: an orb, then the exit last. */
  to: string;
  lengthMeters: number;
  /** Walkable waypoints from the previous stop to `to` (inclusive both ends). */
  path: OrbRunRoutePoint[];
}

export interface OrbRunRoutePlan {
  ok: boolean;
  diagnostics: OrbRunRouteDiagnostic[];
  /** Orbs in the cheapest visiting order (empty when not ok). */
  orbIds: string[];
  legs: OrbRunRouteLeg[];
  /** The whole route as one polyline, start first. */
  path: OrbRunRoutePoint[];
  lengthMeters: number | null;
  /** Walking time at `OrbRunRules.playerSpeed` (no quantisation); null when not ok. */
  estimatedSeconds: number | null;
  /** `timeLimitSeconds - estimatedSeconds`; null when not ok. */
  slackSeconds: number | null;
  /** True when every visiting order was priced (up to `ORB_RUN_ROUTE_EXACT_ORDER_LIMIT` orbs). */
  orderExact: boolean;
  wallCount: number;
}

export interface OrbRunRouteOptions {
  sceneId?: string;
  /** Navmesh voxel size in metres. Default 0.1. */
  cellSize?: number;
}

export const ORB_RUN_ROUTE_EXACT_ORDER_LIMIT = 7;
/**
 * The navmesh agent is a little fatter than the gameplay circle (0.4 m): the
 * extra 0.1 m absorbs voxel rounding and the bot's eight-direction wobble.
 */
export const ORB_RUN_NAV_AGENT_RADIUS = 0.5;
/** Walls are baked as solid boxes this tall: anything above the agent's climb is an obstacle. */
export const ORB_RUN_NAV_WALL_HEIGHT = 2;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** `RecastNavMesh.closestPoint` throws this (message prefix) when no walkable polygon is inside the query extents. */
function isNoClosestPointError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("No closest point found");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boxGeometry(wall: OrbRunWall, height: number): { positions: number[]; indices: number[] } {
  const x0 = wall.x - wall.halfWidth;
  const x1 = wall.x + wall.halfWidth;
  const z0 = wall.z - wall.halfDepth;
  const z1 = wall.z + wall.halfDepth;
  const positions = [
    x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1,
    x0, height, z0, x1, height, z0, x1, height, z1, x0, height, z1,
  ];
  const indices = [
    4, 7, 6, 4, 6, 5, // top (up)
    0, 1, 2, 0, 2, 3, // bottom
    0, 4, 5, 0, 5, 1, // -z side
    1, 5, 6, 1, 6, 2, // +x side
    2, 6, 7, 2, 7, 3, // +z side
    3, 7, 4, 3, 4, 0, // -x side
  ];
  return { positions, indices };
}

/** The triangle soup the navmesh is baked from: a floor square whose walkable part is exactly the arena, plus the walls. */
export function orbRunNavGeometry(
  arenaHalfExtent: number,
  walls: readonly OrbRunWall[],
): { positions: number[]; indices: number[] } {
  const h = arenaHalfExtent + ORB_RUN_NAV_AGENT_RADIUS;
  const positions = [-h, 0, -h, -h, 0, h, h, 0, h, h, 0, -h];
  const indices = [0, 1, 2, 0, 2, 3];
  for (const wall of walls) {
    const box = boxGeometry(wall, ORB_RUN_NAV_WALL_HEIGHT);
    const offset = positions.length / 3;
    positions.push(...box.positions);
    indices.push(...box.indices.map((index) => index + offset));
  }
  return { positions, indices };
}

function polylineLength(points: readonly OrbRunRoutePoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.z - points[index - 1]!.z);
  }
  return total;
}

function permutations(count: number): number[][] {
  const result: number[][] = [];
  const current: number[] = [];
  const used = Array.from({ length: count }, () => false);
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

function failed(diagnostics: OrbRunRouteDiagnostic[], wallCount: number): OrbRunRoutePlan {
  return {
    ok: false,
    diagnostics,
    orbIds: [],
    legs: [],
    path: [],
    lengthMeters: null,
    estimatedSeconds: null,
    slackSeconds: null,
    orderExact: true,
    wallCount,
  };
}

/**
 * Plan the shortest walkable route start -> every orb -> exit. Never throws on
 * bad project data: structural problems come back as `level_invalid`
 * diagnostics (the `analyzeOrbRunLevel` errors), unreachable stops as
 * `route_blocked` naming the entity.
 */
export async function planOrbRunRoute(project: ProjectDocument, options: OrbRunRouteOptions = {}): Promise<OrbRunRoutePlan> {
  const sceneId = options.sceneId ?? ORB_RUN_SCENE_ID;
  const level = analyzeOrbRunLevel(project, { sceneId });
  if (!level.ok || !level.rules) {
    const diagnostics = level.diagnostics
      .filter((entry: OrbRunLevelDiagnostic) => entry.severity === "error")
      .map((entry): OrbRunRouteDiagnostic => ({
        severity: "error",
        code: "level_invalid",
        message: `${entry.code}: ${entry.message}`,
        ...(entry.entityId ? { entityId: entry.entityId } : {}),
      }));
    return failed(diagnostics, level.walls.length);
  }

  const scene = project.scenes.find((candidate) => candidate.id === sceneId)!;
  const rules = level.rules;
  const limit = rules.arenaHalfExtent;
  const clamp = (value: number): number => Math.max(-limit, Math.min(limit, value));
  const positionOf = (components: Record<string, unknown>): OrbRunRoutePoint => {
    const position = (components.Transform as { position: number[] }).position;
    return { x: clamp(position[0]!), z: clamp(position[2]!) };
  };
  const scriptOf = (components: Record<string, unknown>): unknown => (components.Script as { scriptId?: unknown } | undefined)?.scriptId;

  const player = scene.entities.find((entity) => scriptOf(entity.components) === ORB_RUN_SCRIPT.player)!;
  const exit = scene.entities.find((entity) => entity.name === "Exit")!;
  const orbs = scene.entities
    .filter((entity) => scriptOf(entity.components) === ORB_RUN_SCRIPT.orb)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stops = [
    { id: player.id, point: positionOf(player.components) },
    ...orbs.map((orb) => ({ id: orb.id, point: positionOf(orb.components) })),
    { id: exit.id, point: positionOf(exit.components) },
  ];
  const walls = readOrbRunWalls(scene.entities);

  const geometry = orbRunNavGeometry(limit, walls);
  const mesh = await RecastNavMesh.bake({
    positions: geometry.positions,
    indices: geometry.indices,
    cellSize: options.cellSize ?? 0.1,
    cellHeight: 0.1,
    agentHeight: 1,
    agentRadius: ORB_RUN_NAV_AGENT_RADIUS,
    agentMaxClimb: 0.3,
    agentMaxSlope: 45,
  });
  try {
    // Snap every stop onto the walkable floor (never onto a wall top: the y extent is small).
    // A stop with no walkable floor within reach (walled in tighter than the agent, or buried in a wall) is a
    // `route_blocked` diagnostic naming it, not an exception.
    const halfExtents = { x: 1, y: 0.5, z: 1 };
    const diagnostics: OrbRunRouteDiagnostic[] = [];
    const snapped = stops.map((stop, index) => {
      try {
        const point = mesh.closestPoint({ x: stop.point.x, y: 0, z: stop.point.z }, { halfExtents });
        return { id: stop.id, point: { x: point.x, z: point.z } };
      } catch (error) {
        const label = index === 0 ? "The player's start" : index === stops.length - 1 ? "The exit" : `Orb ${stop.id}`;
        // Only the navmesh's own "nothing walkable within reach" answer means the stop is walled in. Any other
        // failure (disposed mesh, WASM fault, non-finite input) keeps its cause instead of posing as a blocked route.
        diagnostics.push(
          isNoClosestPointError(error)
            ? {
                severity: "error",
                code: "route_blocked",
                message: `${label} has no walkable floor within 1 m: walls close it in tighter than the route agent fits`,
                entityId: stop.id,
              }
            : {
                severity: "error",
                code: "navmesh_error",
                message: `The navigation mesh failed while snapping ${label.toLowerCase()} to the floor: ${errorMessage(error)}`,
                entityId: stop.id,
              },
        );
        return { id: stop.id, point: stop.point };
      }
    });
    if (diagnostics.length > 0) return failed(diagnostics, walls.length);

    const count = stops.length;
    const legPath: Array<Array<OrbRunRoutePoint[] | null>> = Array.from({ length: count }, () => Array.from({ length: count }, (): OrbRunRoutePoint[] | null => null));
    for (let from = 0; from < count; from += 1) {
      for (let to = 1; to < count; to += 1) {
        if (from === to) continue;
        const result = mesh.computePath(
          { x: snapped[from]!.point.x, y: 0, z: snapped[from]!.point.z },
          { x: snapped[to]!.point.x, y: 0, z: snapped[to]!.point.z },
          { halfExtents },
        );
        if (result.success) legPath[from]![to] = result.points.map((point) => ({ x: point.x, z: point.z }));
      }
    }
    // Which stops can the player reach at all? (only the player -> stop legs say.)
    for (let to = 1; to < count; to += 1) {
      if (!legPath[0]![to]) {
        diagnostics.push({
          severity: "error",
          code: "route_blocked",
          message: `${to === count - 1 ? "The exit" : `Orb ${stops[to]!.id}`} cannot be reached from the player's start: walls close it off`,
          entityId: stops[to]!.id,
        });
      }
    }
    if (diagnostics.length > 0) return failed(diagnostics, walls.length);

    const orbIndexes = orbs.map((_, index) => index + 1);
    const exitIndex = count - 1;
    const cost = (order: number[]): number => {
      let total = 0;
      let from = 0;
      for (const to of [...order, exitIndex]) {
        const path = legPath[from]![to];
        if (!path) return Number.POSITIVE_INFINITY;
        total += polylineLength(path);
        from = to;
      }
      return total;
    };

    let best: number[] = [];
    let bestCost = Number.POSITIVE_INFINITY;
    let orderExact = true;
    if (orbIndexes.length <= ORB_RUN_ROUTE_EXACT_ORDER_LIMIT) {
      for (const order of permutations(orbIndexes.length)) {
        const candidate = order.map((index) => orbIndexes[index]!);
        const value = cost(candidate);
        if (value < bestCost) {
          bestCost = value;
          best = candidate;
        }
      }
    } else {
      orderExact = false;
      const remaining = new Set(orbIndexes);
      let from = 0;
      while (remaining.size > 0) {
        let next = -1;
        let nextCost = Number.POSITIVE_INFINITY;
        for (const candidate of remaining) {
          const path = legPath[from]![candidate];
          const value = path ? polylineLength(path) : Number.POSITIVE_INFINITY;
          if (value < nextCost) {
            nextCost = value;
            next = candidate;
          }
        }
        if (next < 0) return failed([{ severity: "error", code: "route_blocked", message: "No orb is reachable from the current stop" }], walls.length);
        best.push(next);
        remaining.delete(next);
        from = next;
      }
      bestCost = cost(best);
    }
    if (!Number.isFinite(bestCost)) {
      return failed([{ severity: "error", code: "route_blocked", message: "No walkable visiting order reaches every orb and the exit" }], walls.length);
    }

    const legs: OrbRunRouteLeg[] = [];
    let from = 0;
    for (const to of [...best, exitIndex]) {
      const path = legPath[from]![to]!;
      legs.push({ to: stops[to]!.id, lengthMeters: round(polylineLength(path)), path });
      from = to;
    }
    const path: OrbRunRoutePoint[] = [];
    for (const leg of legs) path.push(...(path.length === 0 ? leg.path : leg.path.slice(1)));
    const lengthMeters = round(polylineLength(path));
    const estimatedSeconds = round(lengthMeters / rules.playerSpeed);
    return {
      ok: true,
      diagnostics: [],
      orbIds: best.map((index) => stops[index]!.id),
      legs,
      path,
      lengthMeters,
      estimatedSeconds,
      slackSeconds: round(rules.timeLimitSeconds - estimatedSeconds),
      orderExact,
      wallCount: walls.length,
    };
  } finally {
    mesh.dispose();
  }
}

/** Points every `spacing` metres along a polyline (corners kept), so an eight-direction bot hugs the path. */
export function densifyRoute(path: readonly OrbRunRoutePoint[], spacing = 0.25): OrbRunRoutePoint[] {
  if (!(spacing > 0)) throw new RangeError("spacing must be > 0");
  const out: OrbRunRoutePoint[] = path.length > 0 ? [{ ...path[0]! }] : [];
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1]!;
    const b = path[index]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const pieces = Math.max(1, Math.ceil(length / spacing));
    for (let piece = 1; piece <= pieces; piece += 1) {
      const t = piece / pieces;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

export interface OrbRunFollowResult {
  steps: number;
  /** Waypoints the bot reached before the run ended or it got stuck. */
  reached: number;
  total: number;
}

/**
 * Playtest bot that follows a planned route with semantic input only.
 * Stops as soon as the run finishes or the player is blocked.
 */
export function followOrbRunRoute(
  simulation: HeadlessSceneSimulation,
  plan: OrbRunRoutePlan,
  options: { maxSteps?: number; stopWhen?: () => boolean; playerSpeed?: number; spacing?: number } = {},
): OrbRunFollowResult {
  const waypoints = densifyRoute(plan.path, options.spacing ?? 0.25);
  const maxSteps = options.maxSteps ?? 6000;
  let steps = 0;
  let reached = 0;
  for (const waypoint of waypoints) {
    if (options.stopWhen?.() || steps >= maxSteps) break;
    const used = walkStraightTo(simulation, waypoint, {
      maxSteps: maxSteps - steps,
      within: 0.15,
      ...(options.stopWhen ? { stopWhen: options.stopWhen } : {}),
      ...(options.playerSpeed !== undefined ? { playerSpeed: options.playerSpeed } : {}),
    });
    steps += used;
    const position = simulation.getPosition(ORB_RUN_ENTITY.player);
    if (!position || Math.hypot(position[0] - waypoint.x, position[2] - waypoint.z) > 0.2) {
      if (!options.stopWhen?.()) break; // blocked short of the waypoint
    }
    reached += 1;
  }
  return { steps, reached, total: waypoints.length };
}

/**
 * An `OrbRunHeadlessProbe` that also reports `state.navigation.*`: the plan `planOrbRunRoute` prices for the probe's
 * project (computed once, on the first snapshot). Lives here, not in `acceptance-probe.ts`, because the planner loads
 * Recast's WASM and the probe is part of the web-bundled package entry.
 */
export function createOrbRunNavigationProbe(options: Omit<OrbRunHeadlessProbeOptions, "routePlanner"> = {}): OrbRunHeadlessProbe {
  return new OrbRunHeadlessProbe({ ...options, routePlanner: (project) => planOrbRunRoute(project) });
}
