import assert from "node:assert/strict";
import test from "node:test";

import {
  base64ToUint8Array,
  calculatePercentiles,
  isEqualJson,
  uint8ArrayToBase64,
} from "../src/runtime-helpers.js";

test("base64 round-trips every byte value, empty input and a multi-chunk payload", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual([...base64ToUint8Array(uint8ArrayToBase64(all))], [...all]);

  assert.equal(uint8ArrayToBase64(new Uint8Array(0)), "");
  assert.equal(base64ToUint8Array("").byteLength, 0);

  const big = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 31 + 7) & 0xff);
  const back = base64ToUint8Array(uint8ArrayToBase64(big));
  assert.equal(back.byteLength, big.byteLength);
  assert.ok(Buffer.from(back).equals(Buffer.from(big)));
});

test("base64 output matches the Node reference encoder (padding included)", () => {
  for (const length of [1, 2, 3, 4, 5, 6]) {
    const bytes = Uint8Array.from({ length }, (_, i) => 250 - i);
    assert.equal(uint8ArrayToBase64(bytes), Buffer.from(bytes).toString("base64"));
  }
});

test("base64ToUint8Array throws on malformed input instead of returning garbage", () => {
  assert.throws(() => base64ToUint8Array("not base64!!"));
});

test("isEqualJson compares nested structures regardless of key order", () => {
  assert.equal(isEqualJson({ a: 1, b: { c: [1, 2, { d: "x" }] } }, { b: { c: [1, 2, { d: "x" }] }, a: 1 }), true);
  assert.equal(isEqualJson({ a: 1 }, { a: 2 }), false);
  assert.equal(isEqualJson({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(isEqualJson([1, 2, 3], [1, 2]), false);
  assert.equal(isEqualJson([1, 2, 3], [1, 3, 2]), false);
  assert.equal(isEqualJson(null, null), true);
  assert.equal(isEqualJson(null, {}), false);
  assert.equal(isEqualJson("1", 1), false);
  assert.equal(isEqualJson(undefined, null), false);
});

test("isEqualJson treats NaN as equal to itself so a clean rollback is not flagged", () => {
  const state = { hp: Number.NaN, nested: [Number.NaN, 1] };
  assert.equal(isEqualJson(state, structuredClone(state)), true);
  assert.equal(isEqualJson({ hp: Number.NaN }, { hp: 0 }), false);
  assert.equal(isEqualJson(Number.NaN, 1), false);
});

test("isEqualJson does not confuse an array with an object holding the same index keys", () => {
  assert.equal(isEqualJson([1], { 0: 1 }), false);
  assert.equal(isEqualJson({ 0: 1, 1: 2 }, [1, 2]), false);
  assert.equal(isEqualJson([], {}), false);
});

test("calculatePercentiles returns zeros for no samples", () => {
  assert.deepEqual(calculatePercentiles([]), { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
});

test("calculatePercentiles of a single sample is that sample everywhere", () => {
  assert.deepEqual(calculatePercentiles([4.2]), { p50Ms: 4.2, p95Ms: 4.2, p99Ms: 4.2, maxMs: 4.2 });
});

test("calculatePercentiles interpolates linearly and does not depend on input order or mutate it", () => {
  const input = [5, 1, 4, 2, 3];
  const snapshot = [...input];
  const result = calculatePercentiles(input);
  assert.deepEqual(input, snapshot);
  // sorted = [1,2,3,4,5]; p50 -> index 2 -> 3; p95 -> index 3.8 -> 4.8; p99 -> index 3.96 -> 4.96
  assert.deepEqual(result, { p50Ms: 3, p95Ms: 4.8, p99Ms: 4.96, maxMs: 5 });
});

test("calculatePercentiles rounds to three decimals and keeps p50 <= p95 <= p99 <= max", () => {
  const samples = Array.from({ length: 101 }, (_, i) => (i * i) / 7);
  const { p50Ms, p95Ms, p99Ms, maxMs } = calculatePercentiles(samples);
  assert.ok(p50Ms <= p95Ms && p95Ms <= p99Ms && p99Ms <= maxMs);
  for (const value of [p50Ms, p95Ms, p99Ms, maxMs]) {
    assert.equal(value, Number(value.toFixed(3)));
  }
  assert.equal(maxMs, Number(((100 * 100) / 7).toFixed(3)));
});
