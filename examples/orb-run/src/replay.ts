import { createHash } from "node:crypto";

import type { ProjectDocument } from "@kinetra/project-model";

import { orbRunAudio, startOrbRunSimulation, summarizeOrbRun, type OrbRunSummary } from "./game.js";
import { ORB_RUN_ACTION } from "./ids.js";
import type { OrbRunStatus } from "./scripts.js";
import type { HeadlessSceneSimulation } from "./simulation.js";

/**
 * Input replays: a run is fully described by its fixed step and the semantic
 * actions held on each step, so recording only the *changes* of the held set
 * is enough to play it back bit for bit. A replay carries digests of the game
 * state (`digestOrbRunState`) at regular checkpoints, so a gameplay change
 * that alters an old recording is caught *and* located: the verifier reports
 * the first checkpoint where the run diverges instead of just "different".
 */

export const ORB_RUN_REPLAY_SCHEMA_VERSION = 1;
/** A replay is a short playtest, not a soak test: 100 minutes at 60 Hz. */
export const ORB_RUN_REPLAY_MAX_STEPS = 360_000;
export const ORB_RUN_DEFAULT_CHECKPOINT_EVERY = 30;
/** `playOrbRunReplay` hands control back to the event loop after this many steps, so a long replay never starves its host. */
export const ORB_RUN_REPLAY_YIELD_EVERY_STEPS = 2048;

export interface OrbRunReplayInput {
  /** 1-based step the held set applies from (the first step that runs with it). */
  step: number;
  /** The complete held set from this step on (empty = everything released). */
  actions: Record<string, number>;
}

export interface OrbRunReplayCheckpoint {
  /** Simulation step after which the digest was taken. */
  step: number;
  digest: string;
}

export interface OrbRunReplay {
  schemaVersion: 1;
  game: "orb-run";
  fixedDeltaSeconds: number;
  totalSteps: number;
  inputs: OrbRunReplayInput[];
  /** Strictly increasing; the last one is at `totalSteps`. */
  checkpoints: OrbRunReplayCheckpoint[];
  outcome: { status: OrbRunStatus; collectedCount: number; totalOrbs: number };
}

export type OrbRunReplayErrorCode =
  | "invalid_replay"
  | "step_mismatch"
  | "recorder_not_fresh"
  | "unknown_action"
  | "replay_too_long"
  | "aborted";

export class OrbRunReplayError extends Error {
  readonly code: OrbRunReplayErrorCode;
  readonly path: string;
  constructor(code: OrbRunReplayErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "OrbRunReplayError";
    this.code = code;
    this.path = path;
  }
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(Object.values(ORB_RUN_ACTION));
const STATUSES: ReadonlySet<string> = new Set(["playing", "won", "lost"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/**
 * Stable SHA-256 of everything gameplay decided so far: step, run summary, the
 * runtime position of every entity, every script's state, the event log and the audio cues.
 * Rendering-side derivations (animation poses, HUD) are *not* in it, so
 * retuning a locomotion curve does not invalidate recorded runs.
 */
export function digestOrbRunState(simulation: HeadlessSceneSimulation): string {
  const summary = summarizeOrbRun(simulation);
  const scripts = simulation
    .scriptStates()
    .map((state) => ({ entityId: state.entityId, scriptId: state.scriptId, state: state.state ?? null }))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  // Every entity with a runtime position, not only the scripted ones: a moved prop or camera is gameplay-visible too.
  const positions = simulation.positions();
  const payload = {
    summary,
    scripts,
    positions,
    events: simulation.events(),
    cues: orbRunAudio(simulation)
      .cues()
      .map((cue) => ({ assetId: cue.assetId, bus: cue.bus, step: cue.step, gain: cue.gain })),
  };
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

function sameActions(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Records the semantic input of a fresh simulation, step by step, until `finish()`. */
export class OrbRunReplayRecorder {
  readonly #simulation: HeadlessSceneSimulation;
  readonly #inputs: OrbRunReplayInput[] = [];
  readonly #checkpoints: OrbRunReplayCheckpoint[] = [];
  #held: Record<string, number> = {};
  #stop: (() => void) | undefined;

  constructor(simulation: HeadlessSceneSimulation, options: { checkpointEvery?: number } = {}) {
    if (simulation.step !== 0) {
      throw new OrbRunReplayError("recorder_not_fresh", "recorder", "a replay can only be recorded from step 0");
    }
    const every = options.checkpointEvery ?? ORB_RUN_DEFAULT_CHECKPOINT_EVERY;
    if (!Number.isInteger(every) || every < 1) {
      throw new RangeError(`checkpointEvery must be an integer >= 1, got ${String(every)}`);
    }
    this.#simulation = simulation;
    // onStep fires after the step ran, when the held set is still the one that step ran with.
    this.#stop = simulation.onStep((current) => {
      const held = current.heldActions();
      if (!sameActions(held, this.#held)) {
        this.#inputs.push({ step: current.step, actions: held });
        this.#held = held;
      }
      if (current.step % every === 0) {
        this.#checkpoints.push({ step: current.step, digest: digestOrbRunState(current) });
      }
    });
  }

  finish(): OrbRunReplay {
    this.#stop?.();
    this.#stop = undefined;
    const simulation = this.#simulation;
    if (simulation.step === 0) {
      throw new OrbRunReplayError("invalid_replay", "$.totalSteps", "nothing was recorded (no step ran)");
    }
    const checkpoints = [...this.#checkpoints];
    if (checkpoints[checkpoints.length - 1]?.step !== simulation.step) {
      checkpoints.push({ step: simulation.step, digest: digestOrbRunState(simulation) });
    }
    const summary = summarizeOrbRun(simulation);
    return {
      schemaVersion: ORB_RUN_REPLAY_SCHEMA_VERSION,
      game: "orb-run",
      fixedDeltaSeconds: simulation.fixedDeltaSeconds,
      totalSteps: simulation.step,
      inputs: structuredClone(this.#inputs),
      checkpoints,
      outcome: { status: summary.status, collectedCount: summary.collectedCount, totalOrbs: summary.totalOrbs },
    };
  }
}

/** Starts a fresh game, lets `play` drive it with semantic input, and returns what was recorded. */
export async function recordOrbRunReplay(
  play: (simulation: HeadlessSceneSimulation) => void | Promise<void>,
  options: { project?: ProjectDocument; checkpointEvery?: number } = {},
): Promise<OrbRunReplay> {
  const simulation = await startOrbRunSimulation(options.project);
  try {
    const recorder = new OrbRunReplayRecorder(simulation, options);
    await play(simulation);
    return recorder.finish();
  } finally {
    await simulation.dispose();
  }
}

function fail(path: string, message: string): never {
  throw new OrbRunReplayError("invalid_replay", path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStepIn(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

/** Strict parse of untrusted replay JSON; throws `OrbRunReplayError` naming the first bad path. */
export function parseOrbRunReplay(value: unknown): OrbRunReplay {
  if (!isRecord(value)) return fail("$", "a replay must be an object");
  const allowed = new Set(["schemaVersion", "game", "fixedDeltaSeconds", "totalSteps", "inputs", "checkpoints", "outcome"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`$.${key}`, "unknown field");
  if (value.schemaVersion !== ORB_RUN_REPLAY_SCHEMA_VERSION) {
    fail("$.schemaVersion", `unsupported replay schema ${String(value.schemaVersion)}`);
  }
  if (value.game !== "orb-run") fail("$.game", `expected "orb-run", got ${JSON.stringify(value.game)}`);
  const delta = value.fixedDeltaSeconds;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta <= 0) {
    return fail("$.fixedDeltaSeconds", "must be a finite number > 0");
  }
  const total = value.totalSteps;
  if (!isStepIn(total, ORB_RUN_REPLAY_MAX_STEPS)) {
    return fail("$.totalSteps", `must be an integer from 1 to ${ORB_RUN_REPLAY_MAX_STEPS}`);
  }
  if (!Array.isArray(value.inputs)) return fail("$.inputs", "must be an array");
  let previous = 0;
  const inputs: OrbRunReplayInput[] = value.inputs.map((raw: unknown, index) => {
    const path = `$.inputs[${index}]`;
    if (!isRecord(raw)) return fail(path, "must be an object");
    for (const key of Object.keys(raw)) if (key !== "step" && key !== "actions") fail(`${path}.${key}`, "unknown field");
    if (!isStepIn(raw.step, total)) return fail(`${path}.step`, `must be an integer from 1 to totalSteps (${total})`);
    if (raw.step <= previous) fail(`${path}.step`, "inputs must be in strictly increasing step order");
    previous = raw.step;
    if (!isRecord(raw.actions)) return fail(`${path}.actions`, "must be an object");
    const actions: Record<string, number> = {};
    for (const [action, amount] of Object.entries(raw.actions)) {
      if (!KNOWN_ACTIONS.has(action)) {
        throw new OrbRunReplayError("unknown_action", `${path}.actions.${action}`, "not an Orb Run action");
      }
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        fail(`${path}.actions.${action}`, "a held action must be a finite number > 0 (release by leaving it out)");
      }
      actions[action] = amount;
    }
    return { step: raw.step, actions };
  });
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length === 0) {
    return fail("$.checkpoints", "must be a non-empty array");
  }
  let lastCheckpoint = 0;
  const checkpoints: OrbRunReplayCheckpoint[] = value.checkpoints.map((raw: unknown, index) => {
    const path = `$.checkpoints[${index}]`;
    if (!isRecord(raw)) return fail(path, "must be an object");
    for (const key of Object.keys(raw)) if (key !== "step" && key !== "digest") fail(`${path}.${key}`, "unknown field");
    if (!isStepIn(raw.step, total)) return fail(`${path}.step`, `must be an integer from 1 to totalSteps (${total})`);
    if (raw.step <= lastCheckpoint) fail(`${path}.step`, "checkpoints must be in strictly increasing step order");
    lastCheckpoint = raw.step;
    if (typeof raw.digest !== "string" || !/^[0-9a-f]{64}$/.test(raw.digest)) {
      return fail(`${path}.digest`, "must be a 64-character lowercase hex SHA-256");
    }
    return { step: raw.step, digest: raw.digest };
  });
  if (lastCheckpoint !== total) fail("$.checkpoints", `the last checkpoint must be at totalSteps (${total})`);
  const outcome = value.outcome;
  if (!isRecord(outcome)) return fail("$.outcome", "must be an object");
  if (typeof outcome.status !== "string" || !STATUSES.has(outcome.status)) {
    fail("$.outcome.status", "must be playing, won or lost");
  }
  for (const key of ["collectedCount", "totalOrbs"] as const) {
    const count = outcome[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      fail(`$.outcome.${key}`, "must be an integer >= 0");
    }
  }
  return {
    schemaVersion: ORB_RUN_REPLAY_SCHEMA_VERSION,
    game: "orb-run",
    fixedDeltaSeconds: delta,
    totalSteps: total,
    inputs,
    checkpoints,
    outcome: {
      status: outcome.status as OrbRunStatus,
      collectedCount: outcome.collectedCount as number,
      totalOrbs: outcome.totalOrbs as number,
    },
  };
}

export interface OrbRunReplayDivergence {
  /** First checkpoint step whose digest differs from the recording. */
  step: number;
  expected: string;
  actual: string;
}

export interface OrbRunReplayResult {
  /** The recording reproduced exactly: every checkpoint digest and the outcome match. */
  verified: boolean;
  divergence?: OrbRunReplayDivergence;
  /** Outcome fields that differ from the recording (`status`, `collectedCount`, `totalOrbs`). */
  outcomeMismatches: string[];
  summary: OrbRunSummary;
  finalDigest: string;
}

export interface PlayOrbRunReplayOptions {
  project?: ProjectDocument;
  onStep?: (simulation: HeadlessSceneSimulation) => void;
  /** Refuse (`replay_too_long`, before any step runs) a replay with more steps than this; defaults to `ORB_RUN_REPLAY_MAX_STEPS`. */
  maxSteps?: number;
  /** Stops the playback at the next yield point (`aborted`) and disposes the simulation. */
  signal?: AbortSignal;
}

/**
 * Plays a replay on a fresh game and checks it against its own checkpoints. Untrusted input is parsed strictly first.
 * Playback is asynchronous: it yields to the event loop every `ORB_RUN_REPLAY_YIELD_EVERY_STEPS` steps, so even a
 * maximum-length replay (360k steps) cannot block a host for the whole run and can be cancelled with `signal`.
 */
export async function playOrbRunReplay(input: unknown, options: PlayOrbRunReplayOptions = {}): Promise<OrbRunReplayResult> {
  const replay = parseOrbRunReplay(input);
  const maxSteps = options.maxSteps ?? ORB_RUN_REPLAY_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError(`maxSteps must be an integer >= 1, got ${String(maxSteps)}`);
  }
  if (replay.totalSteps > maxSteps) {
    throw new OrbRunReplayError("replay_too_long", "$.totalSteps", `${replay.totalSteps} steps exceeds the allowed ${maxSteps}`);
  }
  const abortIfRequested = (): void => {
    if (options.signal?.aborted) {
      throw new OrbRunReplayError("aborted", "$", "replay playback was aborted");
    }
  };
  abortIfRequested();
  const simulation = await startOrbRunSimulation(options.project);
  try {
    if (Math.abs(simulation.fixedDeltaSeconds - replay.fixedDeltaSeconds) > 1e-12) {
      throw new OrbRunReplayError(
        "step_mismatch",
        "$.fixedDeltaSeconds",
        `the replay was recorded at ${replay.fixedDeltaSeconds}s per step, this game runs at ${simulation.fixedDeltaSeconds}s`,
      );
    }
    const checkpoints = new Map(replay.checkpoints.map((checkpoint) => [checkpoint.step, checkpoint.digest]));
    let divergence: OrbRunReplayDivergence | undefined;
    let nextInput = 0;
    for (let step = 1; step <= replay.totalSteps; step += 1) {
      const change = replay.inputs[nextInput];
      if (change && change.step === step) {
        simulation.releaseAllActions();
        for (const [action, amount] of Object.entries(change.actions)) simulation.setAction(action, amount);
        nextInput += 1;
      }
      simulation.advance(1);
      options.onStep?.(simulation);
      if (step % ORB_RUN_REPLAY_YIELD_EVERY_STEPS === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        abortIfRequested();
      }
      const expected = checkpoints.get(step);
      if (expected !== undefined && divergence === undefined) {
        const actual = digestOrbRunState(simulation);
        if (actual !== expected) divergence = { step, expected, actual };
      }
    }
    const summary = summarizeOrbRun(simulation);
    const outcomeMismatches = (["status", "collectedCount", "totalOrbs"] as const).filter(
      (key) => summary[key] !== replay.outcome[key],
    );
    return {
      verified: divergence === undefined && outcomeMismatches.length === 0,
      ...(divergence ? { divergence } : {}),
      outcomeMismatches,
      summary,
      finalDigest: digestOrbRunState(simulation),
    };
  } finally {
    await simulation.dispose();
  }
}
