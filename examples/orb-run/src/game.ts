import type { ProjectDocument } from "@kinetra/project-model";

import { OrbRunAnimator, type OrbRunAnimatorOptions } from "./animator.js";
import { HeadlessAudioService } from "./audio.js";
import { ORB_RUN_DEFAULT_RULES, createOrbRunProject } from "./authoring.js";
import { ORB_RUN_ACTION, ORB_RUN_ENTITY, ORB_RUN_SCENE_ID } from "./ids.js";
import { OrbRunSaveError, validateOrbRunSave } from "./save-validation.js";
import { createOrbRunScriptRegistry, type OrbRunStatus } from "./scripts.js";
import { HeadlessSceneSimulation, type Vec3 } from "./simulation.js";

const animators = new WeakMap<HeadlessSceneSimulation, OrbRunAnimator>();

export async function startOrbRunSimulation(
  project: ProjectDocument = createOrbRunProject(),
  options: OrbRunAnimatorOptions = {},
): Promise<HeadlessSceneSimulation> {
  const simulation = new HeadlessSceneSimulation({
    project,
    sceneId: ORB_RUN_SCENE_ID,
    scripts: createOrbRunScriptRegistry(project, ORB_RUN_SCENE_ID),
    createAudio: (clock) => new HeadlessAudioService(clock),
  });
  await simulation.start();
  animators.set(simulation, new OrbRunAnimator(simulation, options));
  return simulation;
}

/** The runner animator of a simulation started by `startOrbRunSimulation`. */
export function orbRunAnimator(simulation: HeadlessSceneSimulation): OrbRunAnimator {
  const animator = animators.get(simulation);
  if (!animator) throw new Error("This simulation was not started with the Orb Run animator");
  return animator;
}

/** The headless audio service of a simulation started by `startOrbRunSimulation`. */
export function orbRunAudio(simulation: HeadlessSceneSimulation): HeadlessAudioService {
  if (!(simulation.audio instanceof HeadlessAudioService)) {
    throw new Error("This simulation was not started with Orb Run audio");
  }
  return simulation.audio;
}

export interface OrbRunSummary {
  status: OrbRunStatus;
  collectedCount: number;
  totalOrbs: number;
  exitUnlocked: boolean;
  elapsedSeconds: number;
  remainingSeconds: number;
  step: number;
  player: Vec3;
}

/** Structured runtime observation, shaped like what an acceptance step would assert on. */
export function summarizeOrbRun(simulation: HeadlessSceneSimulation): OrbRunSummary {
  const state = simulation.scriptState(ORB_RUN_ENTITY.manager)?.state;
  if (!state) throw new Error("OrbRunManager is not running");
  const player = simulation.getPosition(ORB_RUN_ENTITY.player);
  if (!player) throw new Error("Player has no runtime transform");
  return {
    status: state.status as OrbRunStatus,
    collectedCount: state.collectedCount as number,
    totalOrbs: state.totalOrbs as number,
    exitUnlocked: state.exitUnlocked as boolean,
    elapsedSeconds: state.elapsedSeconds as number,
    remainingSeconds: state.remainingSeconds as number,
    step: simulation.step,
    player,
  };
}

/**
 * Playtest bot: walks the player to `target` (x/z) using only semantic input
 * actions, one axis at a time, never moving further than half a step past the
 * target. Returns the number of simulation steps it used.
 */
export function walkTo(
  simulation: HeadlessSceneSimulation,
  target: { x: number; z: number },
  options: { maxSteps?: number; stopWhen?: () => boolean; playerSpeed?: number } = {},
): number {
  const maxSteps = options.maxSteps ?? 600;
  const tolerance = ((options.playerSpeed ?? ORB_RUN_DEFAULT_RULES.playerSpeed) * simulation.fixedDeltaSeconds) / 2;
  let used = 0;
  for (const axis of ["x", "z"] as const) {
    while (used < maxSteps) {
      if (options.stopWhen?.()) {
        simulation.releaseAllActions();
        return used;
      }
      const position = simulation.getPosition(ORB_RUN_ENTITY.player);
      if (!position) throw new Error("Player has no runtime transform");
      const before = axis === "x" ? position[0] : position[2];
      const delta = (axis === "x" ? target.x : target.z) - before;
      // A step is speed*dt; stop within half of one so the bot never oscillates.
      if (Math.abs(delta) <= tolerance) break;
      const action =
        axis === "x"
          ? delta > 0
            ? ORB_RUN_ACTION.moveRight
            : ORB_RUN_ACTION.moveLeft
          : delta > 0
            ? ORB_RUN_ACTION.moveBackward
            : ORB_RUN_ACTION.moveForward;
      simulation.releaseAllActions();
      simulation.setAction(action, 1);
      simulation.advance(1);
      used += 1;
      const after = simulation.getPosition(ORB_RUN_ENTITY.player)!;
      if ((axis === "x" ? after[0] : after[2]) === before) {
        // Blocked (arena edge, or the run finished and froze the player).
        break;
      }
    }
  }
  simulation.releaseAllActions();
  return used;
}

/**
 * Playtest bot with eight-direction input: walks to `target` (x/z) pressing up to two move
 * actions at once, so it takes the octile shortest path (what `analyzeOrbRunLevel` predicts)
 * instead of `walkTo`'s one-axis-at-a-time Manhattan path. Stops within `within` metres
 * (default: one step) or when `stopWhen` says so. Returns the steps used.
 */
export function walkStraightTo(
  simulation: HeadlessSceneSimulation,
  target: { x: number; z: number },
  options: { maxSteps?: number; stopWhen?: () => boolean; playerSpeed?: number; within?: number } = {},
): number {
  const maxSteps = options.maxSteps ?? 1200;
  const stepLength = (options.playerSpeed ?? ORB_RUN_DEFAULT_RULES.playerSpeed) * simulation.fixedDeltaSeconds;
  const within = options.within ?? stepLength;
  let used = 0;
  while (used < maxSteps) {
    if (options.stopWhen?.()) break;
    const position = simulation.getPosition(ORB_RUN_ENTITY.player);
    if (!position) throw new Error("Player has no runtime transform");
    const dx = target.x - position[0];
    const dz = target.z - position[2];
    if (Math.hypot(dx, dz) <= within) break;
    // A single-axis move covers a whole step; below half of it that axis is done (no oscillation).
    const deadband = stepLength / 2;
    simulation.releaseAllActions();
    if (dx > deadband) simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    else if (dx < -deadband) simulation.setAction(ORB_RUN_ACTION.moveLeft, 1);
    if (dz > deadband) simulation.setAction(ORB_RUN_ACTION.moveBackward, 1);
    else if (dz < -deadband) simulation.setAction(ORB_RUN_ACTION.moveForward, 1);
    simulation.advance(1);
    used += 1;
    const after = simulation.getPosition(ORB_RUN_ENTITY.player)!;
    if (after[0] === position[0] && after[2] === position[2]) break; // blocked or the run froze the player
  }
  simulation.releaseAllActions();
  return used;
}

/** The winning route: every orb, then the exit. */
export const ORB_RUN_WINNING_ROUTE: ReadonlyArray<{ x: number; z: number }> = [
  { x: 4, z: -4 },
  { x: 0, z: 0 },
  { x: -4, z: 4 },
  { x: 4, z: 4 },
];

export interface OrbRunSaveData {
  schemaVersion: 1;
  step: number;
  scripts: Record<string, Record<string, unknown>>;
  positions: Record<string, Vec3>;
}

/** Capture the runtime state needed to resume a run (script state + runtime transforms). */
export function captureOrbRunSave(simulation: HeadlessSceneSimulation): OrbRunSaveData {
  const scripts: Record<string, Record<string, unknown>> = {};
  for (const state of simulation.scriptStates()) {
    if (state.state) scripts[state.entityId] = structuredClone(state.state);
  }
  const positions: Record<string, Vec3> = {};
  for (const id of Object.values(ORB_RUN_ENTITY)) {
    const position = simulation.getPosition(id);
    if (position) positions[id] = position;
  }
  return { schemaVersion: 1, step: simulation.step, scripts, positions };
}

/**
 * Thrown when applying a validated save failed *and* putting the previous state back failed too: the game may be
 * half restored. `cause` is the original failure (the one that explains what went wrong), `rollbackError` is why the
 * undo did not work. When the undo works, the original error is thrown as it is and nothing is left half restored.
 */
export class OrbRunRestoreError extends Error {
  readonly code = "ORB_RUN_RESTORE_FAILED";
  readonly rolledBack = false;
  readonly rollbackError: unknown;

  constructor(cause: unknown, rollbackError: unknown) {
    super(`Orb Run restore failed (${describeError(cause)}) and the rollback failed too (${describeError(rollbackError)})`, {
      cause,
    });
    this.rollbackError = rollbackError;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Restore a save into a started simulation, all or nothing. The save is validated first
 * (`validateOrbRunSave`; throws `OrbRunSaveError` listing every problem, nothing touched). If applying a
 * validated save still fails, the state captured just before is put back, so the game is never left half restored
 * (the original error is thrown); if that undo fails as well, `OrbRunRestoreError` reports both. Either way the
 * runner animation starts again from rest at wherever the player now is, and only a successful restore drops the log,
 * event and audio-cue entries of the abandoned timeline (`discardHistoryAfter`), so a failed one loses no history.
 */
export async function restoreOrbRunSave(
  simulation: HeadlessSceneSimulation,
  save: OrbRunSaveData,
): Promise<void> {
  const issues = validateOrbRunSave(simulation, save);
  if (issues.length > 0) throw new OrbRunSaveError(issues);
  const previous = captureOrbRunSave(simulation);
  try {
    await applyOrbRunSave(simulation, save);
  } catch (error) {
    let failure: unknown = error;
    try {
      await applyOrbRunSave(simulation, previous);
    } catch (rollbackError) {
      failure = new OrbRunRestoreError(error, rollbackError);
    }
    // The animation is derived from the player's position: whatever state the rollback left, it has to follow it.
    animators.get(simulation)?.resync();
    throw failure;
  }
  simulation.discardHistoryAfter(save.step);
  // The animation is derived from movement and isn't saved: restart it from rest.
  animators.get(simulation)?.resync();
}

async function applyOrbRunSave(simulation: HeadlessSceneSimulation, save: OrbRunSaveData): Promise<void> {
  // The clock first: the save's state belongs to its own step, so a quick-load into a run that has moved on must not
  // leave `simulation.step` (and the elapsed time / audio clock derived from it) at the abandoned timeline.
  simulation.restoreStep(save.step);
  for (const [entityId, position] of Object.entries(save.positions)) {
    simulation.restorePosition(entityId, position);
  }
  for (const [entityId, state] of Object.entries(save.scripts)) {
    await simulation.restoreScript(entityId, state);
  }
}
