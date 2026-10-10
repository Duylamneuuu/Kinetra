import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGain } from "../src/gain-value.js";

test("finite values in range pass through", () => {
  assert.equal(normalizeGain(0.4, 1), 0.4);
  assert.equal(normalizeGain(0, 1), 0);
  assert.equal(normalizeGain(1, 0.5), 1);
});

test("out-of-range values clamp, including infinities", () => {
  assert.equal(normalizeGain(-3, 1), 0);
  assert.equal(normalizeGain(7, 0.2), 1);
  assert.equal(normalizeGain(Number.POSITIVE_INFINITY, 0.2), 1);
  assert.equal(normalizeGain(Number.NEGATIVE_INFINITY, 0.2), 0);
});

test("NaN and non-numbers keep the current value instead of poisoning the settings", () => {
  assert.equal(normalizeGain(Number.NaN, 0.35), 0.35);
  assert.equal(normalizeGain(undefined, 0.35), 0.35);
  assert.equal(normalizeGain("0.9", 0.35), 0.35);
  assert.equal(normalizeGain(null, 0.35), 0.35);
});

test("a broken fallback degrades to full volume, never NaN", () => {
  assert.equal(normalizeGain(Number.NaN, Number.NaN), 1);
  assert.equal(normalizeGain(Number.NaN, 5), 1);
  assert.equal(normalizeGain(Number.NaN, -2), 0);
});
