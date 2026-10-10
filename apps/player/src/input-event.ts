/**
 * Pure policy for `PlayerRuntimeController.injectInput`: what a semantic input
 * event is allowed to do, decided before anything is mutated.
 */

export type PlayerInputPhase = "press" | "release" | "hold";

export interface PlayerInputEventLike {
  action: string;
  phase: PlayerInputPhase;
  value?: number | [number, number] | undefined;
}

export type PlayerInputDecision =
  | { kind: "apply"; magnitude: number }
  /** A release is always delivered, even while paused, so an action never stays "pressed" after resume. */
  | { kind: "release-only" }
  | { kind: "blocked" };

/**
 * Magnitude of an input event: a number, the first component of a vector, or 1.
 * Throws a descriptive Error for NaN/Infinity (or a non-finite first component)
 * instead of letting it reach the input router and the physics character motor,
 * where `NaN !== 0` is true and a NaN displacement would poison the body.
 */
export function resolveInputMagnitude(value: PlayerInputEventLike["value"], action: string): number {
  let magnitude: number;
  if (typeof value === "number") {
    magnitude = value;
  } else if (Array.isArray(value) && typeof value[0] === "number") {
    magnitude = value[0];
  } else {
    return 1;
  }
  if (!Number.isFinite(magnitude)) {
    throw new Error(`Input "${action}" has a non-finite value (${String(magnitude)}); expected a finite number`);
  }
  return magnitude;
}

export function decidePlayerInput(event: PlayerInputEventLike, paused: boolean): PlayerInputDecision {
  if (paused) {
    return event.phase === "release" ? { kind: "release-only" } : { kind: "blocked" };
  }
  return { kind: "apply", magnitude: resolveInputMagnitude(event.value, event.action) };
}
