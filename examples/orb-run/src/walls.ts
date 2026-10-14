import type { ComponentMap, JsonValue } from "@kinetra/project-model";

import { ORB_RUN_WALL_COMPONENT } from "./ids.js";

/**
 * Walls: axis-aligned obstacles authored as project data. A wall is any entity
 * with an `OrbRunWall` component `{ halfWidth, halfDepth }` (half extents on x
 * and z, metres) and a `Transform.position` (its centre). The shipped level has
 * none, so its behaviour (and every golden digest) is unchanged; an agent adds
 * a wall with one `entity.create`.
 *
 * Gameplay collision lives here as pure functions so the player script, the
 * static level check and the navigation bake all read the same definition.
 */

/** Radius of the player's circle on the ground plane (the player box is 0.8 m wide). */
export const ORB_RUN_PLAYER_RADIUS = 0.4;

export interface OrbRunWall {
  entityId: string;
  /** Wall centre on the ground plane. */
  x: number;
  z: number;
  halfWidth: number;
  halfDepth: number;
}

export interface OrbRunWallIssue {
  entityId: string;
  message: string;
}

export class OrbRunWallError extends Error {
  readonly code = "ORB_RUN_WALL_INVALID";
  readonly issues: OrbRunWallIssue[];
  constructor(issues: OrbRunWallIssue[]) {
    super(`OrbRunWall invalid: ${issues.map((issue) => `${issue.entityId}: ${issue.message}`).join("; ")}`);
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Read every wall of a scene's entities. Entities without the component are
 * ignored; a malformed wall is reported (all of them at once), never skipped,
 * because a silently missing wall would make the game wrong without a trace.
 */
export function readOrbRunWalls(entities: ReadonlyArray<{ id: string; components: ComponentMap }>): OrbRunWall[] {
  const walls: OrbRunWall[] = [];
  const issues: OrbRunWallIssue[] = [];
  for (const entity of entities) {
    const data = entity.components[ORB_RUN_WALL_COMPONENT];
    if (data === undefined) continue;
    if (!isRecord(data) || !positive(data.halfWidth) || !positive(data.halfDepth)) {
      issues.push({ entityId: entity.id, message: "OrbRunWall needs finite halfWidth > 0 and halfDepth > 0" });
      continue;
    }
    const transform = entity.components.Transform;
    const position = isRecord(transform) && Array.isArray(transform.position) ? transform.position : undefined;
    if (!position || position.length !== 3 || !position.every((value) => typeof value === "number" && Number.isFinite(value))) {
      issues.push({ entityId: entity.id, message: "a wall needs a finite Transform.position" });
      continue;
    }
    walls.push({
      entityId: entity.id,
      x: position[0] as number,
      z: position[2] as number,
      halfWidth: data.halfWidth,
      halfDepth: data.halfDepth,
    });
  }
  if (issues.length > 0) throw new OrbRunWallError(issues);
  return walls.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
}

/** Distance from a ground point to the wall's rectangle (0 inside). */
export function distanceToWall(wall: OrbRunWall, x: number, z: number): number {
  return Math.max(signedDistanceToWall(wall, x, z), 0);
}

/** Whether a circle of `radius` centred at (x, z) overlaps any wall (touching does not count). */
export function circleHitsWall(walls: readonly OrbRunWall[], x: number, z: number, radius = ORB_RUN_PLAYER_RADIUS): boolean {
  return walls.some((wall) => distanceToWall(wall, x, z) < radius - 1e-9);
}

/**
 * Move a circle from `from` towards `to`, one axis at a time: an axis that
 * would end inside a wall is dropped, so the player slides along a wall instead
 * of sticking to it. No walls (or a free path) returns `to` unchanged.
 */
export function resolveWallMotion(
  walls: readonly OrbRunWall[],
  from: { x: number; z: number },
  to: { x: number; z: number },
  radius = ORB_RUN_PLAYER_RADIUS,
): { x: number; z: number } {
  if (walls.length === 0) return { x: to.x, z: to.z };
  let x = from.x;
  let z = from.z;
  if (axisMoveAllowed(walls, x, z, to.x, z, radius)) x = to.x;
  if (axisMoveAllowed(walls, x, z, x, to.z, radius)) z = to.z;
  return { x, z };
}

/**
 * Signed distance from a ground point to a wall's rectangle: positive outside,
 * negative inside (how far the point is from the nearest edge, going out).
 */
export function signedDistanceToWall(wall: OrbRunWall, x: number, z: number): number {
  const dx = Math.abs(x - wall.x) - wall.halfWidth;
  const dz = Math.abs(z - wall.z) - wall.halfDepth;
  if (dx > 0 || dz > 0) return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
  return Math.max(dx, dz);
}

/**
 * A single-axis step is allowed when the circle ends free of every wall. A
 * player who already overlaps a wall (a wall authored or hot-reloaded on top of
 * them) may also take a step that does not push them deeper into THAT wall
 * (and into no wall they were not already overlapping), otherwise every
 * axis would be refused forever and they could never leave. From a free
 * position this is exactly the plain "end free" rule, so behaviour (and every
 * golden digest) outside an overlap is unchanged.
 */
function axisMoveAllowed(
  walls: readonly OrbRunWall[],
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  radius: number,
): boolean {
  // Judged wall by wall: every wall the end position still overlaps must be one
  // the start position already overlapped, and the step must not take the player
  // deeper into it. Easing off wall A never licenses stepping into wall B.
  for (const wall of walls) {
    if (distanceToWall(wall, toX, toZ) >= radius - 1e-9) continue;
    if (distanceToWall(wall, fromX, fromZ) >= radius - 1e-9) return false;
    if (signedDistanceToWall(wall, toX, toZ) < signedDistanceToWall(wall, fromX, fromZ) - 1e-12) return false;
  }
  return true;
}

/** The MCP-shaped `entity.create` components for a wall of `width` x `depth` metres and `height` tall. */
export function orbRunWallComponents(
  centre: { x: number; z: number },
  size: { width: number; depth: number; height?: number },
): ComponentMap {
  const height = size.height ?? 2;
  return {
    Transform: { position: [centre.x, height / 2, centre.z], rotation: [0, 0, 0], scale: [1, 1, 1] },
    Primitive: { kind: "box", size: [size.width, height, size.depth], color: "#64748b" },
    [ORB_RUN_WALL_COMPONENT]: { halfWidth: size.width / 2, halfDepth: size.depth / 2 },
  };
}
