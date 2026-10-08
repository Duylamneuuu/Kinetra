import { stableId } from "@kinetra/project-model";

/**
 * Stable ids for Orb Run. Every id is derived with `stableId` so an agent can
 * re-author the project from scratch and land on byte-identical project data.
 */
export const ORB_RUN_PROJECT_ID = stableId("project", "orb-run");
export const ORB_RUN_PROJECT_NAME = "Orb Run";

export const ORB_RUN_SCENE_ID = stableId("scene", "orb-run/main");
export const ORB_RUN_SCENE_NAME = "Orb Run Courtyard";

export const ORB_RUN_ENTITY = {
  floor: stableId("entity", "orb-run/floor"),
  player: stableId("entity", "orb-run/player"),
  orbA: stableId("entity", "orb-run/orb-a"),
  orbB: stableId("entity", "orb-run/orb-b"),
  orbC: stableId("entity", "orb-run/orb-c"),
  exit: stableId("entity", "orb-run/exit"),
  manager: stableId("entity", "orb-run/manager"),
  camera: stableId("entity", "orb-run/camera"),
  sun: stableId("entity", "orb-run/sun"),
  ambient: stableId("entity", "orb-run/ambient"),
} as const;

export const ORB_RUN_ORB_IDS = [
  ORB_RUN_ENTITY.orbA,
  ORB_RUN_ENTITY.orbB,
  ORB_RUN_ENTITY.orbC,
] as const;

/** Script ids the project references; the script registry must resolve every one. */
export const ORB_RUN_SCRIPT = {
  player: "OrbRunPlayer",
  orb: "OrbRunOrb",
  manager: "OrbRunManager",
} as const;

/** Custom component holding the game rules, authored as project data. */
export const ORB_RUN_RULES_COMPONENT = "OrbRunRules";

/** Semantic input actions (same ids as the engine's default player input map). */
export const ORB_RUN_ACTION = {
  moveRight: "player.moveRight",
  moveLeft: "player.moveLeft",
  moveForward: "player.moveForward",
  moveBackward: "player.moveBackward",
} as const;

/** Gameplay events emitted through the script host. */
export const ORB_RUN_EVENT = {
  orbCollected: "orbRun.orbCollected",
  exitUnlocked: "orbRun.exitUnlocked",
  won: "orbRun.won",
  lost: "orbRun.lost",
} as const;
