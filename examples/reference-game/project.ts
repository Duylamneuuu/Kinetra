import { validateProject, type ProjectDocument } from "@kinetra/project-model";
import arenaProjectJson from "./arena.kinetra.json" with { type: "json" };
import { ARENA_ENEMY_MODEL_ASSET_ID } from "./characters.js";

export const canonicalArenaProject: ProjectDocument = arenaProjectJson as unknown as ProjectDocument;

const validationErrors = validateProject(canonicalArenaProject);
if (validationErrors.length > 0) {
  throw new Error(
    `Canonical Arena project schema validation failed: ${JSON.stringify(validationErrors)}`,
  );
}

export const ARENA_PROJECT_ID = canonicalArenaProject.projectId;
export const ARENA_SCENE_ID = canonicalArenaProject.scenes[0]!.id;

export const ARENA_ENTITY_FLOOR = "entity_arena_floor";
export const ARENA_ENTITY_OBSTACLE = "entity_arena_obstacle";
export const ARENA_ENTITY_PLAYER = "entity_arena_player";
export const ARENA_ENTITY_ENEMY = "entity_arena_enemy";
export const ARENA_ENTITY_GOAL = "entity_arena_goal";
export const ARENA_ENTITY_TERMINAL = "entity_arena_terminal";
export const ARENA_ENTITY_CORE = "entity_arena_core";
export const ARENA_ENTITY_MANAGER = "entity_arena_manager";
export const ARENA_ENTITY_CAMERA = "entity_arena_camera";

// Navmesh geometry: 4 floor quads leaving a 4x4 central obstacle void [-2..2, -2..2]
export const arenaNavPositions = [
  // South quad
  -8, 0, -8,   8, 0, -8,   8, 0, -2,  -8, 0, -2,
  // North quad
  -8, 0,  2,   8, 0,  2,   8, 0,  8,  -8, 0,  8,
  // West quad
  -8, 0, -2,  -2, 0, -2,  -2, 0,  2,  -8, 0,  2,
  // East quad
   2, 0, -2,   8, 0, -2,   8, 0,  2,   2, 0,  2,
];

export const arenaNavIndices = [
  0, 2, 1, 0, 3, 2,
  4, 6, 5, 4, 7, 6,
  8, 10, 9, 8, 11, 10,
  12, 14, 13, 12, 15, 14,
];

export function createArenaProject(): ProjectDocument {
  return structuredClone(canonicalArenaProject);
}

