/**
 * Non-finite inputs (NaN / Infinity) to the pure root-motion step contract must
 * never leak NaN into an entity transform: a bad frame step is a zero delta.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeRootMotionStepDelta,
  sampleRootMotionAt,
  type RootMotionMode,
  type RootMotionSample,
} from "../src/index.js";

const walk: RootMotionSample[] = [
  { time: 0, position: [0, 0, 0], yaw: 0 },
  { time: 0.5, position: [0, 0, 0.5], yaw: 0.1 },
  { time: 1, position: [0, 0, 1], yaw: 0.2 },
];

const MODES: RootMotionMode[] = ["extract-xz", "extract-xyz", "extract-xz-yaw"];
const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

function assertZeroFinite(delta: { translation: number[]; yaw: number }, label: string): void {
  for (const component of delta.translation) {
    assert.ok(Number.isFinite(component), `${label}: translation must be finite, got ${String(component)}`);
    assert.equal(component, 0, `${label}: translation must be zero`);
  }
  assert.ok(Number.isFinite(delta.yaw), `${label}: yaw must be finite, got ${String(delta.yaw)}`);
  assert.equal(delta.yaw, 0, `${label}: yaw must be zero`);
}

for (const mode of MODES) {
  for (const looping of [true, false]) {
    test(`computeRootMotionStepDelta(${mode}, looping=${looping}) returns a zero delta for non-finite deltaTime, prevTime, speed`, () => {
      for (const bad of BAD) {
        assertZeroFinite(
          computeRootMotionStepDelta(walk, 1, 0.2, bad, mode, { isLooping: looping }),
          `deltaTime=${bad}`,
        );
        assertZeroFinite(
          computeRootMotionStepDelta(walk, 1, bad, 0.1, mode, { isLooping: looping }),
          `prevTime=${bad}`,
        );
        assertZeroFinite(
          computeRootMotionStepDelta(walk, 1, 0.2, 0.1, mode, { isLooping: looping, speed: bad }),
          `speed=${bad}`,
        );
      }
    });
  }
}

test("computeRootMotionStepDelta returns a zero delta for a non-finite loopDuration", () => {
  for (const bad of BAD) {
    assertZeroFinite(computeRootMotionStepDelta(walk, bad, 0.2, 0.1, "extract-xz"), `loopDuration=${bad}`);
  }
});

test("computeRootMotionStepDelta still produces the real delta for finite inputs", () => {
  const delta = computeRootMotionStepDelta(walk, 1, 0.25, 0.25, "extract-xz");
  assert.ok(Math.abs(delta.translation[2] - 0.25) < 1e-9);
});

test("sampleRootMotionAt treats a non-finite time as the first sample instead of returning NaN", () => {
  for (const bad of BAD) {
    const sampled = sampleRootMotionAt(walk, bad, 1);
    for (const component of sampled.position) {
      assert.ok(Number.isFinite(component), `time=${bad}: position must be finite`);
    }
    assert.ok(Number.isFinite(sampled.yaw), `time=${bad}: yaw must be finite`);
  }
});
