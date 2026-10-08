/**
 * Seeded property + regression tests for the pure root-motion step contract.
 * Failures report the seed and case index so they are reproducible.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeRootMotionStepDelta,
  extractRootMotion,
  sampleRootMotionAt,
  type RootMotionFrameDelta,
  type RootMotionSample,
} from "../src/index.js";

const SEED = 0x726f6f74; // "root"
const CASES = 300;

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function forAll(name: string, body: (rng: () => number) => void): void {
  const rng = createRng(SEED);
  for (let index = 0; index < CASES; index++) {
    try {
      body(rng);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`property "${name}" failed at case ${index} (seed 0x${SEED.toString(16)}): ${message}`, { cause });
    }
  }
}

function range(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

function randomTrack(rng: () => number): { samples: RootMotionSample[]; duration: number } {
  const count = 2 + Math.floor(rng() * 9);
  const duration = range(rng, 0.4, 3);
  const samples: RootMotionSample[] = [];
  let position: [number, number, number] = [range(rng, -2, 2), range(rng, 0, 1), range(rng, -2, 2)];
  let yaw = range(rng, -1, 1);
  for (let i = 0; i < count; i++) {
    samples.push({ time: i === count - 1 ? duration : (duration * i) / (count - 1), position: [...position], yaw });
    position = [position[0] + range(rng, -1, 1), position[1] + range(rng, -0.2, 0.2), position[2] + range(rng, -0.2, 1.5)];
    yaw += range(rng, -0.4, 0.4);
  }
  return { samples, duration };
}

function add(a: RootMotionFrameDelta, b: RootMotionFrameDelta): RootMotionFrameDelta {
  return {
    translation: [a.translation[0] + b.translation[0], a.translation[1] + b.translation[1], a.translation[2] + b.translation[2]],
    yaw: a.yaw + b.yaw,
  };
}

function assertDeltaNear(actual: RootMotionFrameDelta, expected: RootMotionFrameDelta, tolerance = 1e-9): void {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual.translation[i]! - expected.translation[i]!) <= tolerance,
      `translation[${i}] ${actual.translation[i]} vs ${expected.translation[i]}`,
    );
  }
  assert.ok(Math.abs(actual.yaw - expected.yaw) <= tolerance, `yaw ${actual.yaw} vs ${expected.yaw}`);
}

// A straight walk: 1 m/s along +Z over a 1 s loop.
const walk: RootMotionSample[] = [
  { time: 0, position: [0, 0, 0], yaw: 0 },
  { time: 0.5, position: [0, 0, 0.5], yaw: 0 },
  { time: 1, position: [0, 0, 1], yaw: 0 },
];

test("regression: reverse looping playback keeps moving backwards across the loop start", () => {
  // From t=0.05 back by 0.1 s crosses the loop start: expect -0.1 m, not -0.05 m.
  const step = computeRootMotionStepDelta(walk, 1, 0.05, 0.1, "extract-xz", { speed: -1 });
  assertDeltaNear(step, { translation: [0, 0, -0.1], yaw: 0 });
});

test("regression: negative accumulated playback time still yields root motion", () => {
  // The runtime accumulates playbackTime += dt * speed, which goes negative under reverse playback.
  const backwards = computeRootMotionStepDelta(walk, 1, -0.3, 0.1, "extract-xz", { speed: -1 });
  assertDeltaNear(backwards, { translation: [0, 0, -0.1], yaw: 0 });
  const forwards = computeRootMotionStepDelta(walk, 1, -0.3, 0.1, "extract-xz");
  assertDeltaNear(forwards, { translation: [0, 0, 0.1], yaw: 0 });
});

test("property: looping steps are additive for any split, direction and wrap count", () => {
  forAll("looping-additive", (rng) => {
    const { samples, duration } = randomTrack(rng);
    const t = range(rng, -4 * duration, 6 * duration);
    const a = range(rng, -2.5 * duration, 2.5 * duration);
    const b = range(rng, -2.5 * duration, 2.5 * duration);
    if (Math.abs(a) < 1e-6 || Math.abs(b) < 1e-6 || Math.abs(a + b) < 1e-6) return;
    const first = computeRootMotionStepDelta(samples, duration, t, a, "extract-xyz");
    const second = computeRootMotionStepDelta(samples, duration, t + a, b, "extract-xyz");
    const whole = computeRootMotionStepDelta(samples, duration, t, a + b, "extract-xyz");
    assertDeltaNear(add(first, second), whole, 1e-8);
  });
});

test("property: playing a step in reverse exactly undoes it", () => {
  forAll("looping-reverse", (rng) => {
    const { samples, duration } = randomTrack(rng);
    const t = range(rng, -3 * duration, 5 * duration);
    const dt = range(rng, 1e-3, 3 * duration);
    const forward = computeRootMotionStepDelta(samples, duration, t, dt, "extract-xz-yaw");
    const back = computeRootMotionStepDelta(samples, duration, t + dt, dt, "extract-xz-yaw", { speed: -1 });
    assertDeltaNear(add(forward, back), { translation: [0, 0, 0], yaw: 0 }, 1e-8);
  });
});

test("property: whole loops advance by exactly the clip's net displacement per loop", () => {
  forAll("looping-whole-loops", (rng) => {
    const { samples, duration } = randomTrack(rng);
    const loops = 1 + Math.floor(rng() * 4);
    const t = range(rng, 0, 3 * duration);
    const first = samples[0]!;
    const last = samples.at(-1)!;
    const step = computeRootMotionStepDelta(samples, duration, t, loops * duration, "extract-xyz");
    assertDeltaNear(
      step,
      {
        translation: [
          loops * (last.position[0] - first.position[0]),
          loops * (last.position[1] - first.position[1]),
          loops * (last.position[2] - first.position[2]),
        ],
        yaw: 0,
      },
      1e-8,
    );
  });
});

test("property: speed scales the step like a longer delta time", () => {
  forAll("looping-speed", (rng) => {
    const { samples, duration } = randomTrack(rng);
    const t = range(rng, 0, 2 * duration);
    const dt = range(rng, 0.001, 0.2);
    const speed = range(rng, -3, 3);
    if (Math.abs(speed * dt) < 1e-6) return;
    assertDeltaNear(
      computeRootMotionStepDelta(samples, duration, t, dt, "extract-xz-yaw", { speed }),
      computeRootMotionStepDelta(samples, duration, t, dt * speed, "extract-xz-yaw"),
      1e-12,
    );
  });
});

test("property: non-looping playback clamps at both ends and sums to the clip's displacement", () => {
  forAll("non-looping-clamp", (rng) => {
    const { samples, duration } = randomTrack(rng);
    const steps = 3 + Math.floor(rng() * 20);
    const dt = (duration * range(rng, 1.1, 3)) / steps;
    let time = 0;
    let total: RootMotionFrameDelta = { translation: [0, 0, 0], yaw: 0 };
    for (let i = 0; i < steps; i++) {
      total = add(total, computeRootMotionStepDelta(samples, duration, time, dt, "extract-xyz", { isLooping: false }));
      time += dt;
    }
    const first = samples[0]!;
    const last = samples.at(-1)!;
    assertDeltaNear(
      total,
      { translation: [last.position[0] - first.position[0], last.position[1] - first.position[1], last.position[2] - first.position[2]], yaw: 0 },
      1e-9,
    );
    const past = computeRootMotionStepDelta(samples, duration, duration + 0.5, dt, "extract-xyz", { isLooping: false });
    assertDeltaNear(past, { translation: [0, 0, 0], yaw: 0 });
  });
});

test("property: modes project the same raw motion (xz drops Y, only xz-yaw carries yaw, none is zero)", () => {
  forAll("mode-projection", (rng) => {
    const { samples, duration } = randomTrack(rng);
    const t = range(rng, 0, 2 * duration);
    const dt = range(rng, 0.01, duration);
    const xyz = computeRootMotionStepDelta(samples, duration, t, dt, "extract-xyz");
    const xz = computeRootMotionStepDelta(samples, duration, t, dt, "extract-xz");
    const xzYaw = computeRootMotionStepDelta(samples, duration, t, dt, "extract-xz-yaw");
    const none = computeRootMotionStepDelta(samples, duration, t, dt, "none");
    assert.deepEqual(xz.translation, [xyz.translation[0], 0, xyz.translation[2]]);
    assert.equal(xz.yaw, 0);
    assert.equal(xyz.yaw, 0);
    assert.deepEqual(xzYaw.translation, xz.translation);
    assert.deepEqual(none, { translation: [0, 0, 0], yaw: 0 });
  });
});

test("property: sampleRootMotionAt hits samples exactly and stays inside each segment's bounds", () => {
  forAll("sample-at", (rng) => {
    const { samples, duration } = randomTrack(rng);
    const k = Math.floor(rng() * samples.length);
    const exact = sampleRootMotionAt(samples, samples[k]!.time, duration);
    assert.deepEqual(exact.position, samples[k]!.position);
    const time = range(rng, 0, duration);
    const value = sampleRootMotionAt(samples, time, duration);
    const i = Math.max(0, samples.findIndex((s) => s.time > time) - 1);
    const s0 = samples[i]!;
    const s1 = samples[Math.min(samples.length - 1, i + 1)]!;
    for (let axis = 0; axis < 3; axis++) {
      const lo = Math.min(s0.position[axis]!, s1.position[axis]!) - 1e-12;
      const hi = Math.max(s0.position[axis]!, s1.position[axis]!) + 1e-12;
      assert.ok(value.position[axis]! >= lo && value.position[axis]! <= hi, `axis ${axis} out of segment`);
    }
  });
});

test("property: extractRootMotion deltas sum to the net displacement and in-place samples pin the extracted axes", () => {
  forAll("extract", (rng) => {
    const { samples } = randomTrack(rng);
    const snapshot = structuredClone(samples);
    const result = extractRootMotion(samples, "extract-xz-yaw");
    assert.deepEqual(samples, snapshot, "input samples were mutated");
    assert.equal(result.deltas.length, samples.length - 1);
    const sum = result.deltas.reduce(
      (acc, d) => ({ translation: [acc.translation[0] + d.translation[0], acc.translation[1] + d.translation[1], acc.translation[2] + d.translation[2]] as [number, number, number], yaw: acc.yaw + d.yaw }),
      { translation: [0, 0, 0] as [number, number, number], yaw: 0 },
    );
    const first = samples[0]!;
    const last = samples.at(-1)!;
    assertDeltaNear(sum, { translation: [last.position[0] - first.position[0], 0, last.position[2] - first.position[2]], yaw: last.yaw - first.yaw }, 1e-9);
    for (const [i, sample] of result.inPlace.entries()) {
      assert.ok(Math.abs(sample.position[0] - first.position[0]) < 1e-12);
      assert.ok(Math.abs(sample.position[2] - first.position[2]) < 1e-12);
      assert.equal(sample.position[1], samples[i]!.position[1]);
      assert.equal(sample.yaw, first.yaw);
    }
  });
});
