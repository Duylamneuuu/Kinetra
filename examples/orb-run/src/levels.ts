import { CommandBus } from "@kinetra/command-bus";
import { stableId, type ComponentMap, type ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_DEFAULT_RULES,
  orbRunAuthoringPlan,
  toEngineCommand,
  createEmptyOrbRunProject,
  type OrbRunAuthoringStep,
} from "./authoring.js";
import { ORB_RUN_ENTITY, ORB_RUN_RULES_COMPONENT, ORB_RUN_SCENE_ID } from "./ids.js";
import { orbRunWallComponents } from "./walls.js";
import { orbRunSlowZoneComponents } from "./zones.js";

/**
 * The level pack: more than one authored course for the same game. A level is *data*: the shipped courtyard
 * (`orbRunAuthoringPlan()`, unchanged) plus the walls and mud an agent would add with `entity.create`, plus an
 * optional clock for the `OrbRunRules` it patches last. Nothing here changes a script, so every level plays by the
 * same rules and is held by the same tooling (level check, route planner, fuzzer, replays, acceptance manifests).
 *
 * Every obstacle keeps at least 0.9 m clear of the player start, the three orbs and the exit of the courtyard
 * (`test/levels.test.ts` guards it), so no level buries something the player has to reach.
 */

export interface OrbRunLevelWall {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface OrbRunLevelMud {
  x: number;
  z: number;
  radius: number;
  speedMultiplier: number;
}

export interface OrbRunLevelDefinition {
  /** Stable, lower-case id (`classic`, `pillars`, ...). */
  id: string;
  title: string;
  /** One line of what makes the level different. */
  summary: string;
  walls: readonly OrbRunLevelWall[];
  mud: readonly OrbRunLevelMud[];
  /** The clock this level is played on (seconds); `ORB_RUN_DEFAULT_RULES.timeLimitSeconds` when absent. */
  timeLimitSeconds?: number;
}

export const ORB_RUN_LEVELS: readonly OrbRunLevelDefinition[] = [
  {
    id: "classic",
    title: "Classic Courtyard",
    summary: "The shipped level: an open courtyard, three orbs, a locked exit.",
    walls: [],
    mud: [],
  },
  {
    id: "pillars",
    title: "Pillar Field",
    summary: "Three 1 m pillars on the diagonal: the shortest line is never free.",
    walls: [
      { x: -2, z: -1.5, width: 1, depth: 1 },
      { x: 1.5, z: 1, width: 1, depth: 1 },
      { x: 2, z: -2.5, width: 1, depth: 1 },
    ],
    mud: [],
    timeLimitSeconds: 16,
  },
  {
    id: "swamp",
    title: "Middle Swamp",
    summary: "A slow lake sits on the middle orb: it is worth crossing, not avoiding.",
    walls: [],
    mud: [{ x: 0, z: 0, radius: 2.2, speedMultiplier: 0.4 }],
    timeLimitSeconds: 14,
  },
  {
    id: "causeway",
    title: "Muddy Causeway",
    summary: "A long wall across the middle and a mud patch on the far side: wall and mud together.",
    walls: [{ x: -1, z: 1.5, width: 4, depth: 0.5 }],
    mud: [{ x: 2, z: -1, radius: 1.5, speedMultiplier: 0.5 }],
    timeLimitSeconds: 14,
  },
];

export const ORB_RUN_LEVEL_IDS: readonly string[] = ORB_RUN_LEVELS.map((level) => level.id);

/** The level with this id; an unknown id is a `RangeError` that lists the valid ones. */
export function getOrbRunLevel(id: string): OrbRunLevelDefinition {
  const level = ORB_RUN_LEVELS.find((candidate) => candidate.id === id);
  if (!level) {
    throw new RangeError(`Unknown Orb Run level "${String(id)}"; known levels: ${ORB_RUN_LEVEL_IDS.join(", ")}`);
  }
  return level;
}

/** Entity ids of a level's obstacles: derived with `stableId`, so re-authoring lands on the same bytes. */
export function orbRunLevelWallId(levelId: string, index: number): string {
  return stableId("entity", `orb-run/level/${levelId}/wall-${index}`);
}

export function orbRunLevelMudId(levelId: string, index: number): string {
  return stableId("entity", `orb-run/level/${levelId}/mud-${index}`);
}

/**
 * The authoring plan of a level, in MCP tool-call shape: the shipped courtyard plan, then one `entity.create` per
 * wall and per mud patch, then (only when the level has its own clock) one `entity.patch` of `OrbRunRules`.
 * `classic` is exactly `orbRunAuthoringPlan()`.
 */
export function orbRunLevelPlan(id: string): OrbRunAuthoringStep[] {
  const level = getOrbRunLevel(id);
  const plan = orbRunAuthoringPlan();
  level.walls.forEach((wall, index) => {
    plan.push({
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: orbRunLevelWallId(level.id, index),
        name: `Wall ${index + 1}`,
        components: orbRunWallComponents({ x: wall.x, z: wall.z }, { width: wall.width, depth: wall.depth }) as ComponentMap,
      },
    });
  });
  level.mud.forEach((patch, index) => {
    plan.push({
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: orbRunLevelMudId(level.id, index),
        name: `Mud ${index + 1}`,
        components: orbRunSlowZoneComponents({ x: patch.x, z: patch.z }, patch) as ComponentMap,
      },
    });
  });
  if (level.timeLimitSeconds !== undefined && level.timeLimitSeconds !== ORB_RUN_DEFAULT_RULES.timeLimitSeconds) {
    plan.push({
      tool: "entity.patch",
      args: {
        entityId: ORB_RUN_ENTITY.manager,
        component: ORB_RUN_RULES_COMPONENT,
        patch: { timeLimitSeconds: level.timeLimitSeconds },
      },
    });
  }
  return plan;
}

/** Author a level from an empty project through the typed command bus, one revision per step. */
export function authorOrbRunLevelWithCommandBus(id: string): CommandBus {
  const bus = new CommandBus(createEmptyOrbRunProject());
  orbRunLevelPlan(id).forEach((step, index) => {
    const result = bus.execute({ ...toEngineCommand(step, index), expectedProjectRevision: bus.revision });
    if (!result.ok) {
      throw new Error(`Orb Run level "${id}": authoring step ${index} (${step.tool}) was refused: ${JSON.stringify(result)}`);
    }
  });
  return bus;
}

export function createOrbRunLevelProject(id: string): ProjectDocument {
  return authorOrbRunLevelWithCommandBus(id).snapshot().project;
}
