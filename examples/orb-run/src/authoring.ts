import { CommandBus, type EngineCommand } from "@kinetra/command-bus";
import {
  createProject,
  type ComponentMap,
  type JsonObject,
  type ProjectDocument,
} from "@kinetra/project-model";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_PROJECT_ID,
  ORB_RUN_PROJECT_NAME,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  ORB_RUN_SCENE_NAME,
  ORB_RUN_SCRIPT,
} from "./ids.js";

/**
 * One authoring step, expressed exactly as the MCP tool call an agent would
 * send to `kinetra-mcp`. The same plan is replayed through the MCP server
 * (tests) and directly through the command bus (`createOrbRunProject`), and
 * both must produce byte-identical canonical project data.
 */
export type OrbRunAuthoringStep =
  | { tool: "scene.create"; args: { id: string; name: string } }
  | {
      tool: "entity.create";
      args: { sceneId: string; id: string; name: string; components: ComponentMap };
    }
  | { tool: "entity.patch"; args: { entityId: string; component: string; patch: JsonObject } };

export interface OrbRunRules {
  /** Seconds the player has to collect every orb and reach the exit. */
  timeLimitSeconds: number;
  /** Horizontal distance at which an orb is picked up. */
  pickupRadius: number;
  /** Horizontal distance from the exit centre that counts as "inside". */
  exitRadius: number;
  /** Player speed in metres per second. */
  playerSpeed: number;
  /** Half extent of the walkable square, centred on the origin. */
  arenaHalfExtent: number;
}

export const ORB_RUN_DEFAULT_RULES: OrbRunRules = {
  timeLimitSeconds: 20,
  pickupRadius: 0.75,
  exitRadius: 1,
  playerSpeed: 4,
  arenaHalfExtent: 5.5,
};

function transform(position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  return { position, rotation, scale: [1, 1, 1] };
}

function orb(id: string, name: string, position: [number, number, number]): OrbRunAuthoringStep {
  return {
    tool: "entity.create",
    args: {
      sceneId: ORB_RUN_SCENE_ID,
      id,
      name,
      components: {
        Transform: transform(position),
        Primitive: { kind: "sphere", radius: 0.35, color: "#facc15", metalness: 0.6, roughness: 0.25 },
        Script: { scriptId: ORB_RUN_SCRIPT.orb, order: 0 },
      },
    },
  };
}

/**
 * The full authoring plan. The final step deliberately *patches* the rules
 * (instead of authoring them inline) to dogfood `entity.patch` on a custom
 * gameplay component.
 */
export function orbRunAuthoringPlan(): OrbRunAuthoringStep[] {
  return [
    { tool: "scene.create", args: { id: ORB_RUN_SCENE_ID, name: ORB_RUN_SCENE_NAME } },
    {
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.floor,
        name: "Floor",
        components: {
          Transform: transform([0, -0.1, 0]),
          Primitive: { kind: "box", size: [12, 0.2, 12], color: "#1f2937" },
        },
      },
    },
    {
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.player,
        name: "Player",
        components: {
          Transform: transform([-4, 0.5, -4]),
          Primitive: { kind: "box", size: [0.8, 1, 0.8], color: "#38bdf8" },
          Script: { scriptId: ORB_RUN_SCRIPT.player, order: -10 },
        },
      },
    },
    orb(ORB_RUN_ENTITY.orbA, "OrbA", [4, 0.5, -4]),
    orb(ORB_RUN_ENTITY.orbB, "OrbB", [0, 0.5, 0]),
    orb(ORB_RUN_ENTITY.orbC, "OrbC", [-4, 0.5, 4]),
    {
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.exit,
        name: "Exit",
        components: {
          Transform: transform([4, 0.05, 4]),
          Primitive: { kind: "box", size: [2, 0.1, 2], color: "#ef4444" },
        },
      },
    },
    {
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.manager,
        name: "OrbRunManager",
        components: {
          Transform: transform([0, 0, 0]),
          Script: { scriptId: ORB_RUN_SCRIPT.manager, order: 10 },
          [ORB_RUN_RULES_COMPONENT]: { ...ORB_RUN_DEFAULT_RULES, timeLimitSeconds: 60 },
        },
      },
    },
    {
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.camera,
        name: "MainCamera",
        components: {
          Transform: transform([0, 12, 10], [-0.88, 0, 0]),
          Camera: { type: "perspective", fov: 50, near: 0.1, far: 100 },
        },
      },
    },
    {
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.sun,
        name: "Sun",
        components: {
          Transform: transform([4, 10, 6]),
          Light: { kind: "directional", color: "#ffffff", intensity: 1.2 },
        },
      },
    },
    {
      tool: "entity.create",
      args: {
        sceneId: ORB_RUN_SCENE_ID,
        id: ORB_RUN_ENTITY.ambient,
        name: "Ambient",
        components: {
          Transform: transform([0, 0, 0]),
          Light: { kind: "ambient", color: "#94a3b8", intensity: 0.5 },
        },
      },
    },
    {
      tool: "entity.patch",
      args: {
        entityId: ORB_RUN_ENTITY.manager,
        component: ORB_RUN_RULES_COMPONENT,
        patch: { timeLimitSeconds: ORB_RUN_DEFAULT_RULES.timeLimitSeconds },
      },
    },
  ];
}

/** The empty project an agent starts from before running the plan. */
export function createEmptyOrbRunProject(): ProjectDocument {
  return createProject({ name: ORB_RUN_PROJECT_NAME, projectId: ORB_RUN_PROJECT_ID });
}

/** Translate one MCP-shaped step into the typed engine command it maps onto. */
export function toEngineCommand(step: OrbRunAuthoringStep, index: number): EngineCommand {
  const requestId = `orb-run-step-${index}`;
  switch (step.tool) {
    case "scene.create":
      return {
        requestId,
        command: "scene.create",
        payload: { scene: { id: step.args.id, name: step.args.name, entities: [] } },
      };
    case "entity.create":
      return {
        requestId,
        command: "entity.create",
        payload: {
          sceneId: step.args.sceneId,
          entity: {
            id: step.args.id,
            name: step.args.name,
            components: structuredClone(step.args.components),
          },
        },
      };
    case "entity.patch":
      return {
        requestId,
        command: "component.patch",
        payload: {
          entityId: step.args.entityId,
          component: step.args.component,
          patch: structuredClone(step.args.patch),
        },
      };
  }
}

/**
 * Author Orb Run from an empty project through the typed command bus, one
 * revision per step, with revision preconditions so a stale plan fails loudly.
 */
export function authorOrbRunWithCommandBus(): CommandBus {
  const bus = new CommandBus(createEmptyOrbRunProject());
  orbRunAuthoringPlan().forEach((step, index) => {
    bus.execute({ ...toEngineCommand(step, index), expectedProjectRevision: bus.revision });
  });
  return bus;
}

export function createOrbRunProject(): ProjectDocument {
  return authorOrbRunWithCommandBus().snapshot().project;
}
