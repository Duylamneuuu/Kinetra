/**
 * Normalises a user-supplied volume (settings slider, saved settings) to the [0, 1] range.
 *
 * `Math.max(0, Math.min(1, NaN))` is `NaN`, so a slider event whose `parseFloat(value)` was `NaN`
 * (an empty or garbled value) used to store `masterGain: NaN` in the in-memory settings, push NaN
 * into the audio bus and persist it as `null` (JSON has no NaN), which then failed settings
 * validation on the next boot. Non-finite input now falls back to `fallback` (the current value);
 * `+/-Infinity` saturates like any other out-of-range number.
 *
 * Free of DOM / Electron imports so it can be unit-tested under plain Node.
 */
export function normalizeGain(value: unknown, fallback: number): number {
  const safeFallback = typeof fallback === "number" && Number.isFinite(fallback) ? Math.max(0, Math.min(1, fallback)) : 1;
  if (typeof value !== "number" || Number.isNaN(value)) return safeFallback;
  return Math.max(0, Math.min(1, value));
}
