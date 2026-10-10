import assert from "node:assert/strict";
import test from "node:test";

import { assertFiniteVec3, translatedPosition } from "../src/finite-vec3.js";

test("assertFiniteVec3 returns a fresh tuple for finite input", () => {
  const input = [1, -2.5, 0];
  const out = assertFiniteVec3(input, "pos");
  assert.deepEqual(out, [1, -2.5, 0]);
  assert.notEqual(out, input);
});

test("assertFiniteVec3 rejects NaN, Infinity, wrong length and wrong types", () => {
  for (const bad of [
    [NaN, 0, 0],
    [0, Infinity, 0],
    [0, 0, -Infinity],
    [1, 2],
    [1, 2, 3, 4],
    ["1", 2, 3],
    [null, 2, 3],
    undefined,
    null,
    {},
    "123",
    5,
  ]) {
    assert.throws(() => assertFiniteVec3(bad, "setPosition"), RangeError, String(bad));
  }
});

test("the error names the offending call", () => {
  assert.throws(() => assertFiniteVec3([NaN, 0, 0], "transform.setPosition"), /transform\.setPosition/);
});

test("translatedPosition adds finite deltas without mutating its inputs", () => {
  const position = [1, 2, 3];
  const delta = [0.5, -2, 4];
  assert.deepEqual(translatedPosition(position, delta, "translate"), [1.5, 0, 7]);
  assert.deepEqual(position, [1, 2, 3]);
  assert.deepEqual(delta, [0.5, -2, 4]);
});

test("translatedPosition rejects a non-finite delta", () => {
  assert.throws(() => translatedPosition([0, 0, 0], [NaN, 0, 0], "translate"), RangeError);
  assert.throws(() => translatedPosition([0, 0, 0], [0, Infinity, 0], "translate"), RangeError);
});

test("translatedPosition rejects a sum that overflows to Infinity", () => {
  const big = Number.MAX_VALUE;
  assert.throws(() => translatedPosition([big, 0, 0], [big, 0, 0], "translate"), RangeError);
});

test("translatedPosition rejects an already-corrupted current position", () => {
  assert.throws(() => translatedPosition([NaN, 0, 0], [1, 0, 0], "translate"), RangeError);
});
