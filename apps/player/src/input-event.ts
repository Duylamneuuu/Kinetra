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

/** Structured error for an input event whose value cannot be used (machine-readable `code`). */
export class PlayerInputError extends Error {
  readonly code = "runtime.input.nonFinite";
  readonly hint = "Send a finite number (or a vector whose first component is finite) as the input value.";
  constructor(message: string) {
    super(message);
    this.name = "PlayerInputError";
  }
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
    throw new PlayerInputError(`Input "${action}" has a non-finite value (${String(magnitude)}); expected a finite number`);
  }
  return magnitude;
}

export function decidePlayerInput(event: PlayerInputEventLike, paused: boolean): PlayerInputDecision {
  if (paused) {
    return event.phase === "release" ? { kind: "release-only" } : { kind: "blocked" };
  }
  // A release carries no magnitude: it must always land, even with a junk value, or the action stays "pressed".
  if (event.phase === "release") {
    return { kind: "apply", magnitude: 0 };
  }
  return { kind: "apply", magnitude: resolveInputMagnitude(event.value, event.action) };
}
