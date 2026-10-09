import { ORB_RUN_ENTITY } from "./ids.js";
import { RUNNER_LEG_RIG, planFootPlacement, type FootPlan, type PlantedFoot } from "./foot-ik.js";
import { ORB_RUN_LOCOMOTION, horizontalSpeed, locomotionWeights } from "./locomotion.js";
import type { HeadlessSceneSimulation, Vec3 } from "./simulation.js";

/**
 * The runner's animation, driven by gameplay and never the other way round.
 *
 * `OrbRunAnimator` watches the headless simulation after every fixed step:
 * horizontal speed of the player -> smoothed speed -> the 1D locomotion blend
 * space (`locomotion.ts`) -> foot placement with the engine's two-bone IK
 * (`foot-ik.ts`) on a ground-height function. It only *reads* runtime
 * transforms; it never writes them and never feeds back into the scripts, so a
 * broken pose can't change who wins (animation is a visual layer, like in the
 * engine's own animation contracts). A failed pose is counted and logged, not
 * thrown.
 *
 * The animator holds derived state only: nothing of it is saved. After a save
 * is restored it starts again from rest (`resync`).
 */

/** Height of the ground under world (x, z), in metres. */
export type GroundHeightFn = (x: number, z: number) => number;

export const FLAT_GROUND: GroundHeightFn = () => 0;

/** First-order smoothing time constant for the speed that drives the blend (seconds). */
export const ORB_RUN_SPEED_SMOOTHING_SECONDS = 0.12;

/** Below this smoothed speed (m/s) the runner is snapped to rest so the blend settles on exactly idle. */
const REST_SPEED = 1e-3;

/** Tolerance (m) for "the ankle is on its target" and "the bone kept its length". */
const PLANT_TOLERANCE = 1e-6;

export type LocomotionClip = "idle" | "walk" | "run";

export interface AnimatedFoot {
  /** Ground height under this foot (m). */
  groundY: number;
  /** Ankle height the IK was asked for: ground + ankle offset. */
  targetY: number;
  /** Ankle height the IK solved. */
  ankleY: number;
  /** Distance from the solved ankle to its target (m). */
  error: number;
  /** The ankle is on its target (|ankleY - targetY| within tolerance). */
  planted: boolean;
  reachable: boolean;
  converged: boolean;
}

export interface OrbRunAnimationState {
  /** Simulation step this pose was computed for. */
  step: number;
  /** Raw horizontal speed over the last step (m/s). */
  speed: number;
  /** Speed after smoothing; the value fed to the blend space (m/s). */
  smoothedSpeed: number;
  /** Weight of every locomotion clip (0 for clips outside the active pair); always sums to 1. */
  weights: Record<LocomotionClip, number>;
  /** Clip with the largest weight (ties break on clip id). */
  dominant: LocomotionClip;
  /** How many times `dominant` changed since the run started. */
  transitions: number;
  /** Dominant clips in the order they were first reached. */
  visited: LocomotionClip[];
  pelvis: Vec3;
  /** How far the pelvis was lowered below standing height (m). */
  pelvisDrop: number;
  feet: { left: AnimatedFoot; right: AnimatedFoot };
  /** Largest deviation of a solved bone from its rig length (m). */
  maxBoneLengthError: number;
  /** Every bone kept its rig length. */
  legsValid: boolean;
  /** Poses that could not be computed (a bad ground function, for example). */
  failedCount: number;
}

export interface OrbRunAnimationFailure {
  step: number;
  message: string;
}

export interface OrbRunAnimatorOptions {
  /** Ground height function. Defaults to flat ground at y = 0. */
  ground?: GroundHeightFn;
  /** Smoothing time constant in seconds (0 disables smoothing). */
  smoothingSeconds?: number;
}

const CLIPS = ORB_RUN_LOCOMOTION.samples.map((sample) => sample.clipId) as LocomotionClip[];

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export class OrbRunAnimator {
  readonly #simulation: HeadlessSceneSimulation;
  readonly #ground: GroundHeightFn;
  readonly #smoothingSeconds: number;
  readonly #failures: OrbRunAnimationFailure[] = [];
  #previous: Vec3;
  #lastStep: number;
  #speed = 0;
  #smoothedSpeed = 0;
  #dominant: LocomotionClip = "idle";
  #transitions = 0;
  #visited: LocomotionClip[] = ["idle"];
  #pose: OrbRunAnimationState | undefined;
  #detach: () => void;

  constructor(simulation: HeadlessSceneSimulation, options: OrbRunAnimatorOptions = {}) {
    const smoothing = options.smoothingSeconds ?? ORB_RUN_SPEED_SMOOTHING_SECONDS;
    if (!Number.isFinite(smoothing) || smoothing < 0) {
      throw new RangeError(`smoothingSeconds must be finite and >= 0, got ${String(smoothing)}`);
    }
    this.#simulation = simulation;
    this.#ground = options.ground ?? FLAT_GROUND;
    this.#smoothingSeconds = smoothing;
    this.#previous = this.#playerPosition();
    this.#lastStep = simulation.step;
    this.#pose = this.#compute(true);
    this.#detach = simulation.onStep(() => this.#sample());
  }

  /** The current pose as plain JSON (a copy). */
  state(): OrbRunAnimationState {
    return structuredClone(this.#pose ?? this.#restPose());
  }

  /** Poses that could not be computed so far (visual only: gameplay was not affected). */
  failures(): OrbRunAnimationFailure[] {
    return structuredClone(this.#failures);
  }

  /**
   * Starts again from rest at the player's current position, for example after
   * a save was restored (the saved run carries no animation state).
   */
  resync(): void {
    this.#previous = this.#playerPosition();
    this.#lastStep = this.#simulation.step;
    this.#speed = 0;
    this.#smoothedSpeed = 0;
    this.#pose = this.#compute(true);
  }

  /** Stop observing the simulation. */
  dispose(): void {
    this.#detach();
  }

  #playerPosition(): Vec3 {
    const position = this.#simulation.getPosition(ORB_RUN_ENTITY.player);
    if (!position) throw new Error("Player has no runtime transform");
    return position;
  }

  #sample(): void {
    const simulation = this.#simulation;
    const position = this.#playerPosition();
    const dt = simulation.fixedDeltaSeconds;
    // A step that doesn't follow the previous one (restored save) has no
    // meaningful velocity: treat it as a standstill.
    const continuous = simulation.step === this.#lastStep + 1;
    this.#speed = continuous ? horizontalSpeed(this.#previous, position, dt) : 0;
    if (!continuous) this.#smoothedSpeed = 0;
    const alpha = this.#smoothingSeconds === 0 ? 1 : 1 - Math.exp(-dt / this.#smoothingSeconds);
    this.#smoothedSpeed += (this.#speed - this.#smoothedSpeed) * alpha;
    if (this.#smoothedSpeed < REST_SPEED && this.#speed === 0) this.#smoothedSpeed = 0;
    this.#previous = position;
    this.#lastStep = simulation.step;
    this.#pose = this.#compute(false);
  }

  #compute(initial: boolean): OrbRunAnimationState {
    const step = this.#simulation.step;
    const weightList = locomotionWeights(this.#smoothedSpeed);
    const weights = Object.fromEntries(CLIPS.map((clip) => [clip, 0])) as Record<LocomotionClip, number>;
    for (const entry of weightList) weights[entry.clipId as LocomotionClip] = entry.weight;
    const dominant = weightList[0]!.clipId as LocomotionClip;
    if (initial) {
      // Construction and resync restart from rest: a fresh run, no transitions yet.
      this.#transitions = 0;
      this.#visited = [dominant];
    } else if (dominant !== this.#dominant) {
      this.#transitions += 1;
      if (!this.#visited.includes(dominant)) this.#visited.push(dominant);
    }
    this.#dominant = dominant;

    let plan: FootPlan | undefined;
    try {
      const [x, , z] = this.#previous;
      plan = planFootPlacement({
        position: [x, 0, z],
        baseGround: this.#ground(x, z),
        leftGround: this.#ground(x - RUNNER_LEG_RIG.hipOffsetX, z),
        rightGround: this.#ground(x + RUNNER_LEG_RIG.hipOffsetX, z),
      });
    } catch (error) {
      this.#failures.push({ step, message: error instanceof Error ? error.message : String(error) });
    }
    if (!plan) {
      // Keep the last good pose; only the bookkeeping that doesn't need IK moves on.
      const previous = this.#pose ?? this.#restPose();
      return {
        ...structuredClone(previous),
        step,
        speed: this.#speed,
        smoothedSpeed: this.#smoothedSpeed,
        weights,
        dominant,
        transitions: this.#transitions,
        visited: [...this.#visited],
        failedCount: this.#failures.length,
      };
    }

    const [px, , pz] = this.#previous;
    const left = this.#foot(plan.feet[0], this.#ground(px - RUNNER_LEG_RIG.hipOffsetX, pz));
    const right = this.#foot(plan.feet[1], this.#ground(px + RUNNER_LEG_RIG.hipOffsetX, pz));
    const maxBoneLengthError = Math.max(...plan.feet.map((foot) => this.#boneError(foot)));
    return {
      step,
      speed: this.#speed,
      smoothedSpeed: this.#smoothedSpeed,
      weights,
      dominant,
      transitions: this.#transitions,
      visited: [...this.#visited],
      pelvis: [...plan.pelvis] as Vec3,
      pelvisDrop: plan.pelvisDrop,
      feet: { left, right },
      maxBoneLengthError,
      legsValid: maxBoneLengthError <= PLANT_TOLERANCE,
      failedCount: this.#failures.length,
    };
  }

  /** Pose reported before any IK succeeded: standing height, feet unplanted. */
  #restPose(): OrbRunAnimationState {
    const foot: AnimatedFoot = {
      groundY: 0,
      targetY: RUNNER_LEG_RIG.ankleHeight,
      ankleY: Number.NaN,
      error: Number.NaN,
      planted: false,
      reachable: false,
      converged: false,
    };
    return {
      step: this.#simulation.step,
      speed: 0,
      smoothedSpeed: 0,
      weights: { idle: 1, walk: 0, run: 0 },
      dominant: "idle",
      transitions: 0,
      visited: ["idle"],
      pelvis: [this.#previous[0], RUNNER_LEG_RIG.pelvisHeight, this.#previous[2]],
      pelvisDrop: 0,
      feet: { left: { ...foot }, right: { ...foot } },
      maxBoneLengthError: Number.NaN,
      legsValid: false,
      failedCount: 0,
    };
  }

  #foot(foot: PlantedFoot, groundY: number): AnimatedFoot {
    return {
      groundY,
      targetY: foot.targetY,
      ankleY: foot.ankle[1],
      error: foot.error,
      planted: Math.abs(foot.ankle[1] - foot.targetY) <= PLANT_TOLERANCE,
      reachable: foot.reachable,
      converged: foot.converged,
    };
  }

  #boneError(foot: PlantedFoot): number {
    return Math.max(
      Math.abs(distance(foot.hip, foot.knee) - RUNNER_LEG_RIG.thighLength),
      Math.abs(distance(foot.knee, foot.ankle) - RUNNER_LEG_RIG.shinLength),
    );
  }
}
