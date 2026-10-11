// Validation of the `performance.sample` parameters, kept free of DOM/Three.js so it can be
// unit-tested under plain Node (like finite-vec3.ts and gain-value.ts).
//
// The raw values come from the bridge (MCP / verification probe). `runtime.step` already refuses
// a non-integer, Infinity or absurd count and a NaN/Infinity/oversized delta; `performance.sample`
// ran the same simulate-and-render loop with no checks at all: `warmupFrames: Infinity` (or 1e9)
// froze the renderer in a synchronous loop, and `fixedDeltaSeconds: NaN` fed NaN to the scripts,
// physics and animation of every later frame.

/** Upper bound for the warm-up or the measured part of one sample (~10 minutes at 60 Hz). */
export const MAX_SAMPLE_FRAMES = 36_000;
/** Upper bound for one fixed step; larger deltas tunnel physics and skip animation events. */
export const MAX_SAMPLE_DELTA_SECONDS = 1;

export interface PerformanceSampleOptionsInput {
  warmupFrames?: unknown;
  sampleFrames?: unknown;
  fixedDeltaSeconds?: unknown;
}

export interface ResolvedPerformanceSampleOptions {
  warmupFrames: number;
  sampleFrames: number;
  fixedDeltaSeconds: number;
}

function missing(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Applies the defaults (10 warm-up frames, 60 measured frames, 1/60 s) and rejects bad values with a TypeError. */
export function resolvePerformanceSampleOptions(
  input: PerformanceSampleOptionsInput = {},
): ResolvedPerformanceSampleOptions {
  const warmupFrames = missing(input.warmupFrames) ? 10 : input.warmupFrames;
  if (
    typeof warmupFrames !== "number" ||
    !Number.isInteger(warmupFrames) ||
    warmupFrames < 0 ||
    warmupFrames > MAX_SAMPLE_FRAMES
  ) {
    throw new TypeError(`warmupFrames must be an integer from 0 to ${MAX_SAMPLE_FRAMES}`);
  }

  const sampleFrames = missing(input.sampleFrames) ? 60 : input.sampleFrames;
  if (
    typeof sampleFrames !== "number" ||
    !Number.isInteger(sampleFrames) ||
    sampleFrames < 1 ||
    sampleFrames > MAX_SAMPLE_FRAMES
  ) {
    throw new TypeError(`sampleFrames must be an integer from 1 to ${MAX_SAMPLE_FRAMES}`);
  }

  const fixedDeltaSeconds = missing(input.fixedDeltaSeconds) ? 1 / 60 : input.fixedDeltaSeconds;
  if (
    typeof fixedDeltaSeconds !== "number" ||
    !Number.isFinite(fixedDeltaSeconds) ||
    fixedDeltaSeconds <= 0 ||
    fixedDeltaSeconds > MAX_SAMPLE_DELTA_SECONDS
  ) {
    throw new TypeError(`fixedDeltaSeconds must be a finite number in (0, ${MAX_SAMPLE_DELTA_SECONDS}]`);
  }

  return { warmupFrames, sampleFrames, fixedDeltaSeconds };
}
