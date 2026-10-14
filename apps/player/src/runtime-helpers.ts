/**
 * Pure helpers used by PlayerRuntimeController. They live apart from the controller (which needs a
 * WebGL renderer and a DOM) so they can be unit-tested under plain Node.
 */

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Structural equality for JSON-shaped values (script state snapshots, used to verify that a
 * rollback restored the pre-transaction state).
 *
 * - `NaN` equals `NaN`: structuredClone preserves it, so a state holding NaN must still match its
 *   own snapshot, otherwise a perfectly clean rollback is reported as an atomicity violation.
 * - An array never equals a plain object with the same index keys.
 */
export function isEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object).sort();
  const keysB = Object.keys(b as object).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]!;
    if (key !== keysB[i]) return false;
    if (!isEqualJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

export interface PercentileTiming {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** How many samples are not finite numbers (NaN, Infinity, or not a number at all). */
export function countInvalidSamples(samples: readonly number[]): number {
  let invalid = 0;
  for (const sample of samples) {
    if (typeof sample !== "number" || !Number.isFinite(sample)) invalid += 1;
  }
  return invalid;
}

/**
 * Linear-interpolated p50/p95/p99 and max of the samples, rounded to microseconds.
 * Any non-finite sample makes every percentile NaN (same contract as the verification package's
 * copy): a NaN breaks the sort comparator, so a finite-looking number would be arbitrary.
 */
export function calculatePercentiles(samples: number[]): PercentileTiming {
  if (samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }

  if (countInvalidSamples(samples) > 0) {
    return { p50Ms: Number.NaN, p95Ms: Number.NaN, p99Ms: Number.NaN, maxMs: Number.NaN };
  }

  const sorted = [...samples].sort((a, b) => a - b);

  const getPercentile = (p: number): number => {
    if (sorted.length === 1) {
      return sorted[0]!;
    }
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
  };

  return {
    p50Ms: Number(getPercentile(50).toFixed(3)),
    p95Ms: Number(getPercentile(95).toFixed(3)),
    p99Ms: Number(getPercentile(99).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(3)),
  };
}
