/**
 * Helpers for records keyed by author-chosen ids (entity ids, asset ids).
 *
 * A plain `{}` literal inherits `Object.prototype`, so `record["__proto__"] = value`
 * does not create a key: it swaps the prototype (or is ignored) and the id is silently
 * lost from snapshots, saves and JSON. Records built here have no prototype, so every id,
 * including `__proto__` and `constructor`, is an ordinary own key that survives
 * `JSON.stringify` and `structuredClone`.
 *
 * This module has no DOM, Electron or Three.js dependency so it can be tested under plain Node.
 */

/** Builds a prototype-less record from key/value pairs, keeping every key as an own property. */
export function createKeyedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    record[key] = value;
  }
  return record;
}

/**
 * Orders strings by UTF-16 code unit. Unlike `localeCompare` the result does not depend on the
 * machine locale or ICU build, so snapshots are byte-identical across machines.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
