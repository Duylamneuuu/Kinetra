// Validation for positions handed to the player's script transform service. Kept free of
// Three.js / DOM imports so it can be unit-tested under plain Node.

export type Vec3Tuple = [number, number, number];

/**
 * Returns `value` as a fresh `[x, y, z]` tuple, or throws `RangeError` when it is not an array of
 * three finite numbers.
 *
 * `transform.setPosition` / `translate` used to write straight into the Three.js object and only
 * afterwards sync the physics body, which rejects non-finite input. A script passing NaN or
 * Infinity therefore threw *after* the render object was already corrupted, leaving it and its
 * physics body disagreeing for good. Validating first means a rejected call changes nothing.
 */
export function assertFiniteVec3(value: unknown, label: string): Vec3Tuple {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((component) => typeof component !== "number" || !Number.isFinite(component))
  ) {
    throw new RangeError(`${label} must be [x, y, z] with finite numbers`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** Adds `delta` to `position` after validating both; the inputs are not modified. */
export function translatedPosition(
  position: ReadonlyArray<number>,
  delta: unknown,
  label: string,
): Vec3Tuple {
  const d = assertFiniteVec3(delta, label);
  const p = assertFiniteVec3(position, "current position");
  const result: Vec3Tuple = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  // Two large finite numbers can still overflow to Infinity.
  return assertFiniteVec3(result, `${label} (result)`);
}
