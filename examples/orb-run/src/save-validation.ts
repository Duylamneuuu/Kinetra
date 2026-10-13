import {
  ORB_RUN_ENTITY,
  ORB_RUN_ORB_IDS,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_STOWED_Y,
  ORB_RUN_WALL_COMPONENT,
} from "./ids.js";
import { parseOrbRunRules } from "./scripts.js";
import type { HeadlessSceneSimulation } from "./simulation.js";
import { circleHitsWall, type OrbRunWall } from "./walls.js";

/**
 * Strict validation of an Orb Run save before anything is restored. A save is untrusted input (a file, a cloud
 * blob, a hand-edited JSON): the engine's per-script `validateRestoreState` only checks each script on its own, so
 * without this a save could move the player outside the arena or into a wall, carry a manager that says "won" with
 * no orb collected, a stowed orb the manager never counted, or a script for an entity that does not exist. Every
 * rule below is a state the game can never reach by playing, so a legitimate save (any step of any run, fuzzed in
 * `test/save-hostile.test.ts`) always passes.
 */

export interface OrbRunSaveIssue {
  /** JSON path into the save, e.g. `positions.<entityId>` or `scripts.<entityId>.status`. */
  path: string;
  message: string;
}

export class OrbRunSaveError extends Error {
  readonly code = "ORB_RUN_SAVE_INVALID";
  readonly issues: OrbRunSaveIssue[];
  constructor(issues: OrbRunSaveIssue[]) {
    super(`Orb Run save invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.issues = issues;
  }
}

/**
 * Longest run a save may claim, in simulated seconds (one day of play). `step` is an integer, so without a ceiling a
 * hand-edited `1e300` is "valid" and drags the clock (and everything derived from it) to a number nobody can play to.
 * It is a time, not a step count, so it holds for any `fixedDeltaSeconds`.
 */
export const ORB_RUN_MAX_SAVE_SECONDS = 24 * 60 * 60;

const STOWED_Y = ORB_RUN_STOWED_Y;
/** Slack (seconds) for float noise when a derived number is compared with the one recomputed from the level's rules. */
const REMAINING_TOLERANCE = 1e-9;
const MANAGER_PATH = `scripts.${ORB_RUN_ENTITY.manager}`;
const ALLOWED_TOP_LEVEL = new Set(["schemaVersion", "step", "scripts", "positions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readVec3(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
    ? [value[0] as number, value[1] as number, value[2] as number]
    : undefined;
}

function authoredPosition(simulation: HeadlessSceneSimulation, entityId: string): [number, number, number] | undefined {
  const transform = simulation.getAuthoredComponent(entityId, "Transform");
  return isRecord(transform) ? readVec3(transform.position) : undefined;
}

/** The wall rectangles of the simulation's scene, from authored data (malformed walls cannot exist in a running game). */
function authoredWalls(simulation: HeadlessSceneSimulation, entityIds: readonly string[]): OrbRunWall[] {
  const walls: OrbRunWall[] = [];
  for (const entityId of entityIds) {
    const data = simulation.getAuthoredComponent(entityId, ORB_RUN_WALL_COMPONENT);
    const position = authoredPosition(simulation, entityId);
    if (!isRecord(data) || !position) continue;
    const { halfWidth, halfDepth } = data;
    if (!isFiniteNumber(halfWidth) || !isFiniteNumber(halfDepth) || halfWidth <= 0 || halfDepth <= 0) continue;
    walls.push({ entityId, x: position[0], z: position[2], halfWidth, halfDepth });
  }
  return walls;
}

/**
 * Every problem of `save` against the running `simulation` (the authored level it was started from), all at once.
 * An empty list means `restoreOrbRunSave` will accept it.
 */
export function validateOrbRunSave(simulation: HeadlessSceneSimulation, save: unknown): OrbRunSaveIssue[] {
  if (!isRecord(save)) return [{ path: "", message: "a save must be an object" }];
  const issues: OrbRunSaveIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (save.schemaVersion !== 1) {
    add("schemaVersion", `unsupported schema ${String(save.schemaVersion)} (expected 1)`);
  }
  for (const key of Object.keys(save)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) add(key, "unknown field");
  }
  if (!Number.isInteger(save.step) || (save.step as number) < 0) {
    add("step", "must be an integer >= 0");
  } else if ((save.step as number) * simulation.fixedDeltaSeconds > ORB_RUN_MAX_SAVE_SECONDS) {
    add("step", `a save cannot be older than ${ORB_RUN_MAX_SAVE_SECONDS} s of play (step ${String(save.step)})`);
  }
  if (!isRecord(save.positions)) add("positions", "must be an object keyed by entity id");
  if (!isRecord(save.scripts)) add("scripts", "must be an object keyed by entity id");
  if (!isRecord(save.positions) || !isRecord(save.scripts)) return issues;

  const positions = save.positions;
  const scripts = save.scripts;

  // The same entity sets a capture produces: nothing missing (a half save would restore a half game), nothing extra.
  const knownPositions = new Set<string>();
  for (const id of Object.values(ORB_RUN_ENTITY)) {
    if (simulation.getPosition(id)) knownPositions.add(id);
  }
  const knownScripts = new Set(simulation.scriptStates().filter((state) => state.state).map((state) => state.entityId));
  for (const id of knownPositions) if (!(id in positions)) add(`positions.${id}`, "missing");
  for (const id of Object.keys(positions)) if (!knownPositions.has(id)) add(`positions.${id}`, "unknown entity");
  for (const id of knownScripts) if (!(id in scripts)) add(`scripts.${id}`, "missing");
  for (const id of Object.keys(scripts)) if (!knownScripts.has(id)) add(`scripts.${id}`, "unknown script entity");

  // Script states: the engine's own per-script validation first.
  for (const id of knownScripts) {
    const state = scripts[id];
    if (state === undefined) continue;
    if (!isRecord(state)) {
      add(`scripts.${id}`, "must be an object");
      continue;
    }
    const validation = simulation.validateScriptState(id, state);
    if (!validation.valid) add(`scripts.${id}`, validation.error ?? "rejected by the script");
  }

  // Positions: finite, and where the game can put each entity.
  const entityIds = Object.keys(simulation.positions());
  const walls = authoredWalls(simulation, entityIds);
  let rules: ReturnType<typeof parseOrbRunRules> | undefined;
  try {
    rules = parseOrbRunRules(simulation.getAuthoredComponent(ORB_RUN_ENTITY.manager, ORB_RUN_RULES_COMPONENT));
  } catch {
    rules = undefined; // a running game has valid rules; stay quiet if the level is somehow not Orb Run
  }

  const manager = isRecord(scripts[ORB_RUN_ENTITY.manager]) ? (scripts[ORB_RUN_ENTITY.manager] as Record<string, unknown>) : undefined;
  const managerCollected = new Set(Array.isArray(manager?.collectedOrbIds) ? (manager.collectedOrbIds as unknown[]) : []);

  for (const id of knownPositions) {
    if (!(id in positions)) continue;
    const path = `positions.${id}`;
    const position = readVec3(positions[id]);
    if (!position) {
      add(path, "must be [x, y, z] with finite numbers");
      continue;
    }
    const authored = authoredPosition(simulation, id);
    if (!authored) continue;
    if (id === ORB_RUN_ENTITY.player) {
      if (position[1] !== authored[1]) add(path, `the player stays at height ${authored[1]}, got ${position[1]}`);
      if (rules) {
        const limit = rules.arenaHalfExtent;
        if (Math.abs(position[0]) > limit || Math.abs(position[2]) > limit) {
          add(path, `outside the arena (|x|, |z| <= ${limit})`);
        }
      }
      if (circleHitsWall(walls, position[0], position[2])) add(path, "inside a wall");
      continue;
    }
    // Everything else never moves, except a collected orb, which drops to the stowed height.
    const isOrb = (ORB_RUN_ORB_IDS as readonly string[]).includes(id);
    const orbState = scripts[id];
    // An orb whose own state is malformed is already reported under `scripts.<id>`; do not pile a second issue on it.
    if (isOrb && !(isRecord(orbState) && typeof orbState.collected === "boolean")) continue;
    const collected = isRecord(orbState) && orbState.collected === true;
    const expectedY = isOrb && collected ? STOWED_Y : authored[1];
    if (position[0] !== authored[0] || position[2] !== authored[2] || position[1] !== expectedY) {
      add(
        path,
        isOrb
          ? `a ${collected ? "collected" : "waiting"} orb sits at [${authored[0]}, ${expectedY}, ${authored[2]}], got [${position.join(", ")}]`
          : `a static entity stays at [${authored.join(", ")}], got [${position.join(", ")}]`,
      );
    }
  }

  // Cross-script consistency: the pieces of one run have to tell the same story.
  const status = manager?.status;
  if (manager && rules) {
    const elapsed = manager.elapsedSeconds;
    if (isFiniteNumber(elapsed)) {
      if (status === "playing" && elapsed >= rules.timeLimitSeconds) {
        add(`scripts.${ORB_RUN_ENTITY.manager}.elapsedSeconds`, "a run still playing cannot be past its time limit");
      }
      if (status === "lost" && elapsed < rules.timeLimitSeconds) {
        add(`scripts.${ORB_RUN_ENTITY.manager}.elapsedSeconds`, "a lost run must have used its time limit");
      }
    }
    // The derived fields `getState` writes next to the real state are ignored by a restore, so nothing else would
    // notice a save from another level (other orb count, other time limit) or a hand-edited counter.
    if (manager.totalOrbs !== ORB_RUN_ORB_IDS.length) {
      add(`${MANAGER_PATH}.totalOrbs`, `this level has ${ORB_RUN_ORB_IDS.length} orbs, the save says ${String(manager.totalOrbs)}`);
    }
    if (Array.isArray(manager.collectedOrbIds) && manager.collectedCount !== manager.collectedOrbIds.length) {
      add(`${MANAGER_PATH}.collectedCount`, `must equal the number of collected orbs (${manager.collectedOrbIds.length})`);
    }
    if (isFiniteNumber(elapsed)) {
      const remaining = Math.max(0, rules.timeLimitSeconds - elapsed);
      // A tolerance, not `!==`: a save written by another build may add `elapsedSeconds` in a different order and land a
      // few ulps away; only a number that is really another level's (or hand-edited) is refused.
      if (!isFiniteNumber(manager.remainingSeconds) || Math.abs(manager.remainingSeconds - remaining) > REMAINING_TOLERANCE) {
        add(
          `${MANAGER_PATH}.remainingSeconds`,
          `this level allows ${rules.timeLimitSeconds} s, so ${String(remaining)} s remain, the save says ${String(manager.remainingSeconds)}`,
        );
      }
    }
    if (status === "won") {
      const exit = authoredPosition(simulation, ORB_RUN_ENTITY.exit);
      const playerAt = readVec3(positions[ORB_RUN_ENTITY.player]);
      // The run is won on the tick the player is inside the exit radius; the player may still take that tick's step.
      // This assumes `playerSpeed` is the fastest the player ever moves (mud only slows): a boost or dash would widen it.
      // A missing exit or an unreadable player position cannot slip through here: `positions.<id>` above already
      // refuses a position that is absent or not a finite [x, y, z].
      const reach = rules.exitRadius + rules.playerSpeed * simulation.fixedDeltaSeconds;
      if (exit && playerAt) {
        const away = Math.hypot(playerAt[0] - exit[0], playerAt[2] - exit[2]);
        if (away > reach + 1e-9) {
          add(`positions.${ORB_RUN_ENTITY.player}`, `a won run ends with the player at the exit (within ${rules.exitRadius} m), not ${away.toFixed(2)} m away`);
        }
      }
      if (manager.exitUnlocked !== true) add(`scripts.${ORB_RUN_ENTITY.manager}.status`, "a won run has unlocked the exit");
      if (managerCollected.size !== ORB_RUN_ORB_IDS.length) {
        add(`scripts.${ORB_RUN_ENTITY.manager}.status`, "a won run has collected every orb");
      }
    }
  }
  for (const id of ORB_RUN_ORB_IDS) {
    const orb = scripts[id];
    if (!isRecord(orb) || typeof orb.collected !== "boolean") continue;
    const counted = managerCollected.has(id);
    // The manager ignores a pickup that lands after the verdict, so only a *playing* run must agree exactly.
    if (counted && !orb.collected) add(`scripts.${id}.collected`, "the manager counts this orb but it is still waiting");
    if (!counted && orb.collected && status === "playing") {
      add(`scripts.${id}.collected`, "collected but the manager of a playing run has not counted it");
    }
  }
  const player = scripts[ORB_RUN_ENTITY.player];
  if (isRecord(player) && typeof player.finished === "boolean" && (status === "playing" || status === "won" || status === "lost")) {
    if (player.finished !== (status !== "playing")) {
      add(`scripts.${ORB_RUN_ENTITY.player}.finished`, "the player is frozen exactly when the run is over");
    }
  }
  return issues;
}
