import type { ProjectDocument } from "@kinetra/project-model";

export const ARENA_PROJECT_ID = "project_kinetra_arena";
export const ARENA_SCENE_ID = "scene_arena";

export const ARENA_ENTITY_FLOOR = "entity_arena_floor";
export const ARENA_ENTITY_OBSTACLE = "entity_arena_obstacle";
export const ARENA_ENTITY_PLAYER = "entity_arena_player";
export const ARENA_ENTITY_ENEMY = "entity_arena_enemy";
export const ARENA_ENTITY_GOAL = "entity_arena_goal";
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
  return {
    schemaVersion: 1,
    projectId: ARENA_PROJECT_ID,
    name: "Kinetra Arena",
    scenes: [
      {
        id: ARENA_SCENE_ID,
        name: "Arena Combat Room",
        entities: [
          {
            id: ARENA_ENTITY_FLOOR,
            name: "Floor",
            components: {
              Transform: {
                position: [0, -0.1, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [16, 0.2, 16],
                color: "#2b303c",
              },
              NavMesh: {
                positions: arenaNavPositions,
                indices: arenaNavIndices,
              },
            },
          },
          {
            id: ARENA_ENTITY_OBSTACLE,
            name: "Obstacle",
            components: {
              Transform: {
                position: [0, 1, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [4, 2, 4],
                color: "#475569",
              },
            },
          },
          {
            id: "entity_arena_wall_north",
            name: "WallNorth",
            components: {
              Transform: {
                position: [0, 1, 8.5],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [17, 2, 1],
                color: "#1e293b",
              },
            },
          },
          {
            id: "entity_arena_wall_south",
            name: "WallSouth",
            components: {
              Transform: {
                position: [0, 1, -8.5],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [17, 2, 1],
                color: "#1e293b",
              },
            },
          },
          {
            id: "entity_arena_wall_west",
            name: "WallWest",
            components: {
              Transform: {
                position: [-8.5, 1, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [1, 2, 17],
                color: "#1e293b",
              },
            },
          },
          {
            id: "entity_arena_wall_east",
            name: "WallEast",
            components: {
              Transform: {
                position: [8.5, 1, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [1, 2, 17],
                color: "#1e293b",
              },
            },
          },
          {
            id: ARENA_ENTITY_GOAL,
            name: "Goal",
            components: {
              Transform: {
                position: [5, 0.1, -5],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [2, 0.2, 2],
                color: "#10b981",
              },
            },
          },
          {
            id: ARENA_ENTITY_PLAYER,
            name: "Player",
            components: {
              Transform: {
                position: [-5, 0.5, -5],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [1, 1, 1],
                color: "#3b82f6",
              },
              Script: {
                scriptId: "ArenaPlayerController",
              },
            },
          },
          {
            id: ARENA_ENTITY_ENEMY,
            name: "Enemy",
            components: {
              Transform: {
                position: [5, 0.5, 5],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Primitive: {
                kind: "box",
                size: [1, 1, 1],
                color: "#ef4444",
              },
              Script: {
                scriptId: "ArenaEnemyController",
              },
            },
          },
          {
            id: ARENA_ENTITY_MANAGER,
            name: "ArenaManager",
            components: {
              Transform: {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Script: {
                scriptId: "ArenaGameManager",
              },
            },
          },
          {
            id: ARENA_ENTITY_CAMERA,
            name: "MainCamera",
            components: {
              Transform: {
                position: [0, 14, 14],
                rotation: [-0.78, 0, 0],
                scale: [1, 1, 1],
              },
              Camera: {
                type: "perspective",
                fov: 50,
                near: 0.1,
                far: 100,
              },
            },
          },
          {
            id: "entity_arena_light_dir",
            name: "DirectionalLight",
            components: {
              Transform: {
                position: [5, 10, 5],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Light: {
                kind: "directional",
                color: "#ffffff",
                intensity: 1.2,
              },
            },
          },
          {
            id: "entity_arena_light_amb",
            name: "AmbientLight",
            components: {
              Transform: {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
              Light: {
                kind: "ambient",
                color: "#94a3b8",
                intensity: 0.6,
              },
            },
          },
        ],
      },
    ],
  };
}
