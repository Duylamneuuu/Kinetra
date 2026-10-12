import type { ComponentMap, JsonValue } from "@kinetra/project-model";

import { ORB_RUN_SLOW_ZONE_COMPONENT } from "./ids.js";

/**
 * Slow zones ("mud"): circular patches authored as project data. A slow zone is
 * any entity with an `OrbRunSlowZone` component `{ radius, speedMultiplier }`
 * (metres on the ground plane, multiplier in (0, 1]) and a
 * `Transform.position` (its centre). While the player's centre is inside a
 * zone (distance to the centre <= radius, boundary included) its speed is
 * `playerSpeed * speedMultiplier`; where zones overlap the slowest one wins.
 * The zone under the player is decided from the position at the *start* of the
 * step, so the rule is a pure function of the previous state and replays stay
 * deterministic.
 *
 * The shipped level has none, so its behaviour (and every golden digest) is
 * unchanged; an agent adds a patch with one `entity.create`. A multiplier above
 * 1 is rejected on purpose: a speed-up would void the level check's lower bound
 * ("nothing can win faster") and the fuzzer's speed ceiling.
 *
 * Like walls, the rule lives here as pure functions so the player script, the
 * static level check and the tests all read the same definition.
 */

export interface OrbRunSlowZone {
  entityId: string;
  /** Zone centre on the ground plane. */
  x: number;
  z: number;
  radius: number;
  /** Fraction of `playerSpeed` that applies inside, in (0, 1]. */
  speedMultiplier: number;
}

export interface OrbRunSlowZoneIssue {
  entityId: string;
  message: string;
}

export class OrbRunSlowZoneError extends Error {
  readonly code = "ORB_RUN_SLOW_ZONE_INVALID";
  readonly issues: OrbRunSlowZoneIssue[];
  constructor(issues: OrbRunSlowZoneIssue[]) {
    super(`OrbRunSlowZone invalid: ${issues.map((issue) => `${issue.entityId}: ${issue.message}`).join("; ")}`);
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Read every slow zone of a scene's entities. Entities without the component are
 * ignored; a malformed zone is reported (all of them at once), never skipped,
 * because a silently missing patch of mud would make the game wrong without a trace.
 */
export function readOrbRunSlowZones(entities: ReadonlyArray<{ id: string; components: ComponentMap }>): OrbRunSlowZone[] {
  const zones: OrbRunSlowZone[] = [];
  const issues: OrbRunSlowZoneIssue[] = [];
  for (const entity of entities) {
    const data = entity.components[ORB_RUN_SLOW_ZONE_COMPONENT];
    if (data === undefined) continue;
    if (!isRecord(data) || !isFinitePositive(data.radius)) {
      issues.push({ entityId: entity.id, message: "OrbRunSlowZone needs a finite radius > 0" });
      continue;
    }
    if (!isFinitePositive(data.speedMultiplier) || data.speedMultiplier > 1) {
      issues.push({ entityId: entity.id, message: "OrbRunSlowZone.speedMultiplier must be a finite number in (0, 1]" });
      continue;
    }
    const transform = entity.components.Transform;
    const position = isRecord(transform) && Array.isArray(transform.position) ? transform.position : undefined;
    if (!position || position.length !== 3 || !position.every((value) => typeof value === "number" && Number.isFinite(value))) {
      issues.push({ entityId: entity.id, message: "a slow zone needs a finite Transform.position" });
      continue;
    }
    zones.push({
      entityId: entity.id,
      x: position[0] as number,
      z: position[2] as number,
      radius: data.radius,
      speedMultiplier: data.speedMultiplier,
    });
  }
  if (issues.length > 0) throw new OrbRunSlowZoneError(issues);
  return zones.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
}

/** Whether the ground point (x, z) is inside the zone (the boundary counts as inside). */
export function insideSlowZone(zone: OrbRunSlowZone, x: number, z: number): boolean {
  return Math.hypot(x - zone.x, z - zone.z) <= zone.radius;
}

/** The fraction of `playerSpeed` that applies at (x, z): the slowest zone covering it, else 1. */
export function slowZoneMultiplierAt(zones: readonly OrbRunSlowZone[], x: number, z: number): number {
  let multiplier = 1;
  for (const zone of zones) {
    if (insideSlowZone(zone, x, z) && zone.speedMultiplier < multiplier) multiplier = zone.speedMultiplier;
  }
  return multiplier;
}

/** Distance between samples when pricing a path through mud, in metres. */
export const ORB_RUN_PATH_PRICE_STEP_METERS = 0.01;

/**
 * Seconds a player at `playerSpeed` needs to walk a polyline on the ground plane, slowed by the zones it crosses:
 * the path is cut into `ORB_RUN_PATH_PRICE_STEP_METERS` pieces and each piece is priced at the speed of the zone
 * under its midpoint (the slowest wins, like the player script). It is the continuous-time cousin of the per-step
 * rule (no 1/30 s quantisation, like the plain `length / speed` estimate); with no zones it is exactly
 * `length / speed`. Pure: the route planner, the tests and any HUD estimate read the same definition.
 */
export function walkSecondsAlong(
  path: ReadonlyArray<{ x: number; z: number }>,
  playerSpeed: number,
  zones: readonly OrbRunSlowZone[],
): number {
  if (!(playerSpeed > 0) || !Number.isFinite(playerSpeed)) throw new RangeError("playerSpeed must be a finite number > 0");
  let length = 0;
  let seconds = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1]!;
    const b = path[index]!;
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    length += segment;
    if (zones.length === 0 || segment === 0) continue;
    const pieces = Math.max(1, Math.ceil(segment / ORB_RUN_PATH_PRICE_STEP_METERS));
    const piece = segment / pieces;
    for (let k = 0; k < pieces; k += 1) {
      const t = (k + 0.5) / pieces;
      const multiplier = slowZoneMultiplierAt(zones, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      seconds += piece / (playerSpeed * multiplier);
    }
  }
  return zones.length === 0 ? length / playerSpeed : seconds;
}

/** The MCP-shaped `entity.create` components for a mud patch of `radius` metres that slows the player to `speedMultiplier`. */
export function orbRunSlowZoneComponents(
  centre: { x: number; z: number },
  options: { radius: number; speedMultiplier: number },
): ComponentMap {
  return {
    // A flat slab just above the floor so it reads as a patch on the ground.
    Transform: { position: [centre.x, 0.02, centre.z], rotation: [0, 0, 0], scale: [1, 1, 1] },
    Primitive: { kind: "box", size: [options.radius * 2, 0.04, options.radius * 2], color: "#78350f" },
    [ORB_RUN_SLOW_ZONE_COMPONENT]: { radius: options.radius, speedMultiplier: options.speedMultiplier },
  };
}
