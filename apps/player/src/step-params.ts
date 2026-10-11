// Validation of the `runtime.step` bridge parameters, kept free of DOM/Three.js so it can be
// unit-tested under plain Node (like sample-options.ts).
//
// A non-integer/Infinity step count would spin the renderer in a synchronous loop forever, and a
// NaN/Infinity/negative delta poisons physics, scripts and animation state for every later frame.
// The verification probe schema (`runtimeStepStepSchema` in @kinetra/verification) uses the same
// bounds so a probe is rejected up front instead of failing mid-run with the player's TypeError.

/** Upper bound for one `runtime.step` call (~10 minutes at 60 Hz). */
export const MAX_STEPS_PER_CALL = 36_000;
/** Upper bound for one fixed step; larger deltas tunnel physics and skip animation events. */
export const MAX_STEP_DELTA_SECONDS = 1;

export interface RuntimeStepParamsInput {
  steps?: unknown;
  deltaSeconds?: unknown;
}

export interface ResolvedRuntimeStepParams {
  steps: number;
  deltaSeconds: number;
}

function missing(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Applies the defaults (1 step of 1/60 s) and rejects bad values with a TypeError. */
export function parseRuntimeStepParams(input: RuntimeStepParamsInput = {}): ResolvedRuntimeStepParams {
  const steps = missing(input.steps) ? 1 : input.steps;
  if (
    typeof steps !== "number" ||
    !Number.isInteger(steps) ||
    steps < 0 ||
    steps > MAX_STEPS_PER_CALL
  ) {
    throw new TypeError(`steps must be an integer from 0 to ${MAX_STEPS_PER_CALL}`);
  }
  const deltaSeconds = missing(input.deltaSeconds) ? 1 / 60 : input.deltaSeconds;
  if (
    typeof deltaSeconds !== "number" ||
    !Number.isFinite(deltaSeconds) ||
    deltaSeconds <= 0 ||
    deltaSeconds > MAX_STEP_DELTA_SECONDS
  ) {
    throw new TypeError(`deltaSeconds must be a finite number in (0, ${MAX_STEP_DELTA_SECONDS}]`);
  }
  return { steps, deltaSeconds };
}
