import type { ProjectDocument } from "@kinetra/project-model";

import { ORB_RUN_ACTION, ORB_RUN_ENTITY, ORB_RUN_EVENT, ORB_RUN_ORB_IDS } from "./ids.js";
import {
  captureOrbRunSave,
  orbRunAnimator,
  orbRunAudio,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  type OrbRunSaveData,
  type OrbRunSummary,
} from "./game.js";
import { buildOrbRunHud, readOrbRunRules } from "./hud.js";
import {
  OrbRunReplayRecorder,
  playOrbRunReplay,
  type OrbRunReplay,
  type OrbRunReplayInput,
} from "./replay.js";
import type { HeadlessSceneSimulation, Vec3 } from "./simulation.js";

/**
 * Seeded input fuzzing for Orb Run.
 *
 * A fuzz run drives a fresh game with *semantic input only* (held move actions, including contradictory and analogue
 * ones), watches every fixed step with `OrbRunInvariantMonitor`, records the run as an `OrbRunReplay` and then checks
 * three cross-run properties on that recording: it replays to the same digests, and a save taken at any step and
 * restored into a fresh game finishes in the same gameplay state as the uninterrupted run. It is the example's
 * answer to "does the game hold up against inputs nobody scripted" and needs no human and no renderer.
 */

export type OrbRunFuzzStrategy = "random" | "seek" | "mixed";

/** mulberry32: a tiny deterministic generator, so a failing seed is a complete bug report. */
export function createSeededRandom(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new RangeError(`seed must be finite, got ${String(seed)}`);
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOVE_ACTIONS = [
  ORB_RUN_ACTION.moveRight,
  ORB_RUN_ACTION.moveLeft,
  ORB_RUN_ACTION.moveForward,
  ORB_RUN_ACTION.moveBackward,
] as const;

/** Held values the fuzzer uses: tiny, nominal and (illegally large, but accepted) analogue amounts. */
const HOLD_VALUES = [0.05, 0.25, 1, 3.5] as const;

export interface OrbRunFuzzDriveOptions {
  seed: number;
  /** Total fixed steps to run (the run keeps stepping after it is won or lost, to prove it stays frozen). */
  steps: number;
  strategy?: OrbRunFuzzStrategy;
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))]!;
}

function randomHold(simulation: HeadlessSceneSimulation, random: () => number): void {
  simulation.releaseAllActions();
  if (random() < 0.12) return; // idle segment
  for (const action of MOVE_ACTIONS) {
    if (random() < 0.4) simulation.setAction(action, pick(random, HOLD_VALUES));
  }
}

function seekHold(simulation: HeadlessSceneSimulation, random: () => number): void {
  simulation.releaseAllActions();
  const summary = summarizeOrbRun(simulation);
  const collected = new Set(
    (simulation.scriptState(ORB_RUN_ENTITY.manager)?.state?.collectedOrbIds as string[] | undefined) ?? [],
  );
  const targets: Vec3[] = [];
  if (summary.collectedCount >= summary.totalOrbs) {
    const exit = simulation.getPosition(ORB_RUN_ENTITY.exit);
    if (exit) targets.push(exit);
  } else {
    for (const id of ORB_RUN_ORB_IDS) {
      const position = simulation.getPosition(id);
      if (position && !collected.has(id)) targets.push(position);
    }
  }
  let best: Vec3 | undefined;
  for (const target of targets) {
    const distance = Math.hypot(target[0] - summary.player[0], target[2] - summary.player[2]);
    const bestDistance = best ? Math.hypot(best[0] - summary.player[0], best[2] - summary.player[2]) : Infinity;
    if (distance < bestDistance) best = target;
  }
  if (!best) return;
  const dx = best[0] - summary.player[0];
  const dz = best[2] - summary.player[2];
  if (dx > 0.15) simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
  else if (dx < -0.15) simulation.setAction(ORB_RUN_ACTION.moveLeft, 1);
  if (dz > 0.15) simulation.setAction(ORB_RUN_ACTION.moveBackward, 1);
  else if (dz < -0.15) simulation.setAction(ORB_RUN_ACTION.moveForward, 1);
  // A fumble now and then, so the bot does not look like a recording of the winning route.
  if (random() < 0.15) simulation.setAction(pick(random, MOVE_ACTIONS), pick(random, HOLD_VALUES));
}

/**
 * Drives `simulation` (fresh or not) for `steps` steps with a seeded policy: hold something for 1–40 steps, repeat.
 * `random` segments hold arbitrary subsets of the four move actions (opposites together, analogue values, idles);
 * `seek` segments steer at the nearest objective with a fumble now and then; `mixed` picks one of them per segment.
 */
export function driveOrbRunFuzz(simulation: HeadlessSceneSimulation, options: OrbRunFuzzDriveOptions): void {
  const { seed, steps } = options;
  if (!Number.isInteger(steps) || steps < 1) throw new RangeError(`steps must be an integer >= 1, got ${String(steps)}`);
  const strategy = options.strategy ?? "mixed";
  const random = createSeededRandom(seed);
  let remaining = steps;
  while (remaining > 0) {
    const useSeek = strategy === "seek" || (strategy === "mixed" && random() < 0.5);
    if (useSeek) seekHold(simulation, random);
    else randomHold(simulation, random);
    const length = Math.min(remaining, 1 + Math.floor(random() * (useSeek ? 12 : 40)));
    simulation.advance(length);
    remaining -= length;
  }
}

export interface OrbRunFuzzViolation {
  step: number;
  invariant: string;
  message: string;
}

/** The stable list of invariant names the monitor can report (documented, and pinned by a test). */
export const ORB_RUN_INVARIANTS = [
  "status_transition",
  "frozen_after_finish",
  "collected_monotonic",
  "collected_consistent",
  "events_consistent",
  "win_preconditions",
  "player_in_arena",
  "static_entities_still",
  "orbs_stowed_when_collected",
  "positions_finite",
  "clock_consistent",
  "audio_consistent",
  "animation_valid",
  "hud_valid",
] as const;
export type OrbRunInvariant = (typeof ORB_RUN_INVARIANTS)[number];

const EPSILON = 1e-6;
/** Where `OrbRunOrb` puts a collected orb (its `HIDDEN_Y`): straight down, out of sight. */
const ORB_STOWED_Y = -10;

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON;
}

function samePosition(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Checks the rules of Orb Run after *every* fixed step of a simulation started with `startOrbRunSimulation`, from
 * outside, using only what a player or an acceptance manifest can observe. Violations are collected (capped) instead
 * of thrown, so one bad step still reports the next.
 */
export class OrbRunInvariantMonitor {
  readonly violations: OrbRunFuzzViolation[] = [];
  /** How many steps were checked. */
  checked = 0;

  readonly #simulation: HeadlessSceneSimulation;
  readonly #limit: number;
  readonly #initialPositions: Record<string, Vec3>;
  readonly #arena: number;
  readonly #timeLimit: number;
  #previous: OrbRunSummary;
  #stop: (() => void) | undefined;

  constructor(simulation: HeadlessSceneSimulation, options: { maxViolations?: number } = {}) {
    this.#simulation = simulation;
    this.#limit = options.maxViolations ?? 50;
    this.#initialPositions = simulation.positions();
    const rules = readOrbRunRules(simulation);
    this.#arena = rules.arenaHalfExtent;
    this.#timeLimit = rules.timeLimitSeconds;
    this.#previous = summarizeOrbRun(simulation);
    this.#stop = simulation.onStep(() => this.#check());
  }

  get ok(): boolean {
    return this.violations.length === 0;
  }

  /** Stop observing. */
  dispose(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  #report(invariant: OrbRunInvariant, message: string): void {
    if (this.violations.length >= this.#limit) return;
    this.violations.push({ step: this.#simulation.step, invariant, message });
  }

  #check(): void {
    const simulation = this.#simulation;
    const previous = this.#previous;
    const current = summarizeOrbRun(simulation);
    this.checked += 1;

    // Status only ever moves playing -> won|lost, and a finished run is frozen.
    if (previous.status !== "playing") {
      if (current.status !== previous.status) {
        this.#report("status_transition", `status changed ${previous.status} -> ${current.status} after the run was over`);
      }
      const frozen =
        current.collectedCount === previous.collectedCount &&
        current.exitUnlocked === previous.exitUnlocked &&
        current.elapsedSeconds === previous.elapsedSeconds &&
        samePosition(current.player, previous.player);
      if (!frozen) this.#report("frozen_after_finish", "the player, clock or orb count changed after the run was over");
    }

    // Orbs: never un-collect, never exceed the total, ids in the script state agree with the count and never repeat.
    if (current.collectedCount < previous.collectedCount) {
      this.#report("collected_monotonic", `collectedCount fell ${previous.collectedCount} -> ${current.collectedCount}`);
    }
    const managerState = simulation.scriptState(ORB_RUN_ENTITY.manager)?.state ?? {};
    const ids = Array.isArray(managerState.collectedOrbIds) ? (managerState.collectedOrbIds as string[]) : [];
    if (
      current.collectedCount > current.totalOrbs ||
      ids.length !== current.collectedCount ||
      new Set(ids).size !== ids.length
    ) {
      this.#report(
        "collected_consistent",
        `collectedCount ${current.collectedCount} of ${current.totalOrbs} disagrees with ids [${ids.join(", ")}]`,
      );
    }

    // Events: one pickup per collected orb, the exit unlocks exactly once and only after the last orb, one verdict.
    const pickups = simulation.events(ORB_RUN_EVENT.orbCollected).length;
    const unlocks = simulation.events(ORB_RUN_EVENT.exitUnlocked).length;
    const wins = simulation.events(ORB_RUN_EVENT.won).length;
    const losses = simulation.events(ORB_RUN_EVENT.lost).length;
    const expectedVerdicts = current.status === "playing" ? 0 : 1;
    if (
      pickups !== current.collectedCount ||
      unlocks !== (current.exitUnlocked ? 1 : 0) ||
      wins !== (current.status === "won" ? 1 : 0) ||
      losses !== (current.status === "lost" ? 1 : 0) ||
      wins + losses !== expectedVerdicts
    ) {
      this.#report(
        "events_consistent",
        `events pickups=${pickups} unlocks=${unlocks} won=${wins} lost=${losses} vs state ${current.status}, ` +
          `${current.collectedCount}/${current.totalOrbs}, exitUnlocked=${String(current.exitUnlocked)}`,
      );
    }
    if (current.exitUnlocked !== (current.collectedCount === current.totalOrbs)) {
      this.#report("win_preconditions", "exitUnlocked must be true exactly when every orb is collected");
    }
    if (current.status === "won" && (!current.exitUnlocked || current.collectedCount !== current.totalOrbs)) {
      this.#report("win_preconditions", "won without collecting every orb and unlocking the exit");
    }

    // Space: the player stays inside the arena, nothing else moves, every coordinate is a number.
    const positions = simulation.positions();
    let finite = true;
    for (const [id, position] of Object.entries(positions)) {
      if (!position.every((value) => Number.isFinite(value))) {
        finite = false;
        this.#report("positions_finite", `entity ${id} has a non-finite position`);
      }
      if (id === ORB_RUN_ENTITY.player) continue;
      const initial = this.#initialPositions[id];
      if (!initial) {
        this.#report("static_entities_still", `entity ${id} appeared at ${JSON.stringify(position)}`);
      } else if ((ORB_RUN_ORB_IDS as readonly string[]).includes(id)) {
        // An orb sits where it was authored until it is picked up, then goes underground, straight down.
        const collected = simulation.scriptState(id)?.state?.collected === true;
        const expected: Vec3 = collected ? [initial[0], ORB_STOWED_Y, initial[2]] : initial;
        if (!samePosition(expected, position)) {
          this.#report(
            "orbs_stowed_when_collected",
            `orb ${id} (collected=${String(collected)}) is at ${JSON.stringify(position)}, expected ${JSON.stringify(expected)}`,
          );
        }
      } else if (!samePosition(initial, position)) {
        this.#report("static_entities_still", `entity ${id} moved from ${JSON.stringify(initial)} to ${JSON.stringify(position)}`);
      }
    }
    if (finite && (Math.abs(current.player[0]) > this.#arena + EPSILON || Math.abs(current.player[2]) > this.#arena + EPSILON)) {
      this.#report("player_in_arena", `player at ${JSON.stringify(current.player)} left the ±${this.#arena} m arena`);
    }

    // Clock: elapsed + remaining is the limit until it runs out; the clock only runs while playing.
    if (
      !approx(current.remainingSeconds, Math.max(0, this.#timeLimit - current.elapsedSeconds)) ||
      current.remainingSeconds < 0 ||
      (current.status === "playing" && current.elapsedSeconds >= this.#timeLimit) ||
      (current.status === "playing" && !approx(current.elapsedSeconds, current.step * simulation.fixedDeltaSeconds))
    ) {
      this.#report(
        "clock_consistent",
        `elapsed ${current.elapsedSeconds} + remaining ${current.remainingSeconds} vs limit ${this.#timeLimit} at step ${current.step} (${current.status})`,
      );
    }

    // Audio: one cue per pickup, one for the exit chime, one verdict cue.
    const cues = orbRunAudio(simulation).cues().length;
    const expectedCues = current.collectedCount + (current.exitUnlocked ? 1 : 0) + expectedVerdicts;
    if (cues !== expectedCues) this.#report("audio_consistent", `${cues} cues played, expected ${expectedCues}`);

    this.#checkAnimation();
    this.#checkHud(current);
    this.#previous = current;
  }

  #checkAnimation(): void {
    const animation = orbRunAnimator(this.#simulation).state();
    const weights = Object.values(animation.weights);
    const sum = weights.reduce((total, weight) => total + weight, 0);
    const finite = [animation.speed, animation.smoothedSpeed, ...weights, ...animation.pelvis].every(Number.isFinite);
    if (!finite || !approx(sum, 1) || weights.some((weight) => weight < 0) || animation.failedCount !== 0 || !animation.legsValid) {
      this.#report(
        "animation_valid",
        `weights ${JSON.stringify(animation.weights)} (sum ${sum}), failedCount ${animation.failedCount}, legsValid ${String(animation.legsValid)}`,
      );
    }
  }

  #checkHud(summary: OrbRunSummary): void {
    const hud = buildOrbRunHud(this.#simulation);
    const finished = summary.status !== "playing";
    const problems: string[] = [];
    if (JSON.stringify(JSON.parse(JSON.stringify(hud))) !== JSON.stringify(hud)) problems.push("not JSON-safe");
    if (!(hud.timer.fraction >= 0 && hud.timer.fraction <= 1)) problems.push(`timer fraction ${hud.timer.fraction}`);
    if (hud.timer.displaySeconds < 0 || !Number.isInteger(hud.timer.displaySeconds)) problems.push("display seconds");
    if (hud.orbs.collected !== summary.collectedCount || hud.orbs.total !== summary.totalOrbs) problems.push("orb counts");
    if (hud.orbs.remaining !== summary.totalOrbs - summary.collectedCount) problems.push("remaining orbs");
    if ((hud.banner !== null) !== finished || (finished && hud.banner?.kind !== summary.status)) problems.push("banner");
    if (finished && hud.marker !== null) problems.push("marker after the run");
    if (!finished && hud.marker === null) problems.push("no marker while playing");
    if (hud.exit.unlocked !== summary.exitUnlocked) problems.push("exit flag");
    if (problems.length > 0) this.#report("hud_valid", problems.join("; "));
  }
}

/** What an observer needs to compare two runs of the same recording: gameplay state without the step counter. */
export interface OrbRunComparableState {
  summary: Omit<OrbRunSummary, "step">;
  positions: Record<string, Vec3>;
  scripts: Array<{ entityId: string; state: Record<string, unknown> | null }>;
}

export function comparableOrbRunState(simulation: HeadlessSceneSimulation): OrbRunComparableState {
  const { step: _step, ...summary } = summarizeOrbRun(simulation);
  return {
    summary,
    positions: simulation.positions(),
    scripts: simulation
      .scriptStates()
      .map((state) => ({ entityId: state.entityId, state: state.state ? structuredClone(state.state) : null }))
      .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0)),
  };
}

/** Applies the recorded input for `step` (if there is one) to `simulation`, then returns the next input index. */
function applyRecordedInput(
  simulation: HeadlessSceneSimulation,
  inputs: readonly OrbRunReplayInput[],
  index: number,
  step: number,
): number {
  const change = inputs[index];
  if (!change || change.step !== step) return index;
  simulation.releaseAllActions();
  for (const [action, amount] of Object.entries(change.actions)) simulation.setAction(action, amount);
  return index + 1;
}

export interface OrbRunSaveResumeResult {
  saveStep: number;
  /** The restored run ended in the same gameplay state as the uninterrupted one. */
  equal: boolean;
  /** Fields of the comparable state that differ (top-level: `summary`, `positions`, `scripts`). */
  differences: string[];
}

/**
 * Plays `replay` up to `saveStep`, saves (through JSON, like a file on disk), restores into a fresh game, plays the
 * rest of the recorded input, and compares the final gameplay state with `expected` (the uninterrupted run).
 */
export async function checkOrbRunSaveResume(
  replay: OrbRunReplay,
  saveStep: number,
  expected: OrbRunComparableState,
  options: { project?: ProjectDocument } = {},
): Promise<OrbRunSaveResumeResult> {
  if (!Number.isInteger(saveStep) || saveStep < 1 || saveStep >= replay.totalSteps) {
    throw new RangeError(`saveStep must be an integer in [1, ${replay.totalSteps - 1}], got ${String(saveStep)}`);
  }
  const first = await startOrbRunSimulation(options.project);
  let save: OrbRunSaveData;
  let held: Record<string, number> = {};
  try {
    let index = 0;
    for (let step = 1; step <= saveStep; step += 1) {
      const next = applyRecordedInput(first, replay.inputs, index, step);
      if (next !== index) held = replay.inputs[index]!.actions;
      index = next;
      first.advance(1);
    }
    save = JSON.parse(JSON.stringify(captureOrbRunSave(first))) as OrbRunSaveData;
  } finally {
    await first.dispose();
  }

  const second = await startOrbRunSimulation(options.project);
  try {
    await restoreOrbRunSave(second, save);
    // Held input is not part of a save: the player is still holding whatever they held when they saved.
    for (const [action, amount] of Object.entries(held)) second.setAction(action, amount);
    let index = replay.inputs.findIndex((change) => change.step > saveStep);
    if (index === -1) index = replay.inputs.length;
    for (let step = saveStep + 1; step <= replay.totalSteps; step += 1) {
      index = applyRecordedInput(second, replay.inputs, index, step);
      second.advance(1);
    }
    const actual = comparableOrbRunState(second);
    const differences = (["summary", "positions", "scripts"] as const).filter(
      (key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
    );
    return { saveStep, equal: differences.length === 0, differences };
  } finally {
    await second.dispose();
  }
}

export interface OrbRunFuzzOptions {
  seed: number;
  /** Fixed steps per run; defaults to 1200 (40 s, twice the default clock). */
  steps?: number;
  strategy?: OrbRunFuzzStrategy;
  project?: ProjectDocument;
  /** Which step to save at for the save/resume property; defaults to a seeded pick. */
  saveStep?: number;
}

export interface OrbRunFuzzResult {
  seed: number;
  strategy: OrbRunFuzzStrategy;
  steps: number;
  /** Everything that went wrong: per-step invariants first, then the cross-run properties. Empty means the run held. */
  violations: OrbRunFuzzViolation[];
  ok: boolean;
  final: OrbRunSummary;
  finalDigest: string;
  /** The run as a replay: paste it into `playOrbRunReplay` to reproduce a failure byte for byte. */
  replay: OrbRunReplay;
  saveStep: number;
}

/** One fuzz run: the per-step invariants plus replay determinism and save/resume equivalence on its own recording. */
export async function runOrbRunFuzz(options: OrbRunFuzzOptions): Promise<OrbRunFuzzResult> {
  const steps = options.steps ?? 1200;
  const strategy = options.strategy ?? "mixed";
  const violations: OrbRunFuzzViolation[] = [];
  const simulation = await startOrbRunSimulation(options.project);
  let replay: OrbRunReplay;
  let final: OrbRunSummary;
  let expected: OrbRunComparableState;
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    const recorder = new OrbRunReplayRecorder(simulation);
    driveOrbRunFuzz(simulation, { seed: options.seed, steps, strategy });
    replay = recorder.finish();
    monitor.dispose();
    violations.push(...monitor.violations);
    final = summarizeOrbRun(simulation);
    expected = comparableOrbRunState(simulation);
  } finally {
    await simulation.dispose();
  }

  const replayed = await playOrbRunReplay(replay, options.project ? { project: options.project } : {});
  if (!replayed.verified) {
    violations.push({
      step: replayed.divergence?.step ?? replay.totalSteps,
      invariant: "replay_deterministic",
      message: `the recording of seed ${options.seed} did not replay to the same digests (${replayed.divergence ? `first at step ${replayed.divergence.step}` : replayed.outcomeMismatches.join(", ")})`,
    });
  }

  const pickRandom = createSeededRandom(options.seed ^ 0x9e3779b9);
  const saveStep = options.saveStep ?? 1 + Math.floor(pickRandom() * (replay.totalSteps - 1));
  const resumed = await checkOrbRunSaveResume(replay, saveStep, expected, options.project ? { project: options.project } : {});
  if (!resumed.equal) {
    violations.push({
      step: saveStep,
      invariant: "save_resume_equivalent",
      message: `saving at step ${saveStep} and resuming ended differently in: ${resumed.differences.join(", ")}`,
    });
  }

  return {
    seed: options.seed,
    strategy,
    steps,
    violations,
    ok: violations.length === 0,
    final,
    finalDigest: replayed.finalDigest,
    replay,
    saveStep,
  };
}

export interface OrbRunFuzzCampaign {
  runs: number;
  failures: OrbRunFuzzResult[];
  /** How many runs ended in each status: a campaign that never wins or never loses proves little. */
  outcomes: Record<"won" | "lost" | "playing", number>;
  /** Runs that collected at least one orb / every orb. */
  collectedSome: number;
  collectedAll: number;
}

/** Runs seeds `[firstSeed, firstSeed + count)` and summarises them. */
export async function runOrbRunFuzzCampaign(options: {
  firstSeed: number;
  count: number;
  steps?: number;
  strategy?: OrbRunFuzzStrategy;
  project?: ProjectDocument;
}): Promise<OrbRunFuzzCampaign> {
  if (!Number.isInteger(options.count) || options.count < 1) throw new RangeError("count must be an integer >= 1");
  const campaign: OrbRunFuzzCampaign = {
    runs: 0,
    failures: [],
    outcomes: { won: 0, lost: 0, playing: 0 },
    collectedSome: 0,
    collectedAll: 0,
  };
  for (let offset = 0; offset < options.count; offset += 1) {
    const result = await runOrbRunFuzz({
      seed: options.firstSeed + offset,
      ...(options.steps !== undefined ? { steps: options.steps } : {}),
      ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
      ...(options.project !== undefined ? { project: options.project } : {}),
    });
    campaign.runs += 1;
    campaign.outcomes[result.final.status] += 1;
    if (result.final.collectedCount > 0) campaign.collectedSome += 1;
    if (result.final.collectedCount === result.final.totalOrbs) campaign.collectedAll += 1;
    if (!result.ok) campaign.failures.push(result);
  }
  return campaign;
}
