import assert from "node:assert/strict";
import test from "node:test";

import { createClipEventTracker } from "../src/events.js";

// #189 item 3: in loop mode the head used to be an unbounded float (`k * D + time`), so after
// many loops rounding drift made events on the loop boundary go missing. The head now keeps an
// integer loop count plus a time inside [0, D).

function boundaryTracker(duration: number, time = 0) {
  return createClipEventTracker({
    clip: "c",
    duration,
    loop: true,
    events: [{ clip: "c", name: "e", time, payload: {} }],
  }).tracker;
}

for (const duration of [0.1, 1 / 3, 0.7]) {
  test(`loop of ${duration}s advanced one full clip per step fires the boundary event every loop`, () => {
    const tracker = boundaryTracker(duration);
    const steps = 100_000;
    const loops: number[] = [];
    for (let i = 0; i < steps; i += 1) {
      for (const fire of tracker.advance(duration).fired) loops.push(fire.loop);
    }
    // The start point (loop 0) plus one boundary per step.
    assert.equal(loops.length, steps + 1, "boundary events were dropped by drift");
    assert.deepEqual(loops.slice(0, 3), [0, 1, 2]);
    assert.equal(loops[loops.length - 1], steps);
    assert.equal(new Set(loops).size, loops.length, "an event fired twice for the same loop");
    assert.ok(tracker.time >= 0 && tracker.time < duration);
  });
}

test("small fixed steps over many loops fire each mid-clip and boundary event exactly once per loop", () => {
  const duration = 1 / 3;
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration,
    loop: true,
    events: [
      { clip: "c", name: "start", time: 0, payload: {} },
      { clip: "c", name: "mid", time: duration / 2, payload: {} },
    ],
  });
  const counts = new Map<string, Set<number>>([["start", new Set()], ["mid", new Set()]]);
  let total = 0;
  for (let i = 0; i < 600_000; i += 1) {
    for (const fire of tracker.advance(1 / 60).fired) {
      total += 1;
      counts.get(fire.name)?.add(fire.loop);
    }
  }
  const lastLoop = Math.floor((600_000 / 60) / duration + 1e-6);
  assert.equal(counts.get("mid")?.size, lastLoop, "mid event once per loop");
  assert.ok((counts.get("start")?.size ?? 0) >= lastLoop, "start event once per completed loop");
  assert.equal(total, (counts.get("mid")?.size ?? 0) + (counts.get("start")?.size ?? 0), "no duplicates");
});

test("after a seek to a huge position the head still moves and fires", () => {
  const tracker = boundaryTracker(1, 0.5);
  tracker.seek(2 ** 53);
  let fired = 0;
  for (let i = 0; i < 8; i += 1) fired += tracker.advance(0.25).fired.length;
  assert.equal(fired, 2, "advance must not be swallowed by float resolution");
  assert.equal(tracker.time, 0);
});

test("reverse playback across many loops keeps counting loops down without gaps", () => {
  const duration = 1 / 3;
  const tracker = boundaryTracker(duration, duration / 2);
  const loops: number[] = [];
  for (let i = 0; i < 50_000; i += 1) {
    for (const fire of tracker.advance(-duration).fired) loops.push(fire.loop);
  }
  assert.equal(loops.length, 50_000);
  assert.deepEqual(loops.slice(0, 2), [-1, -2]);
  assert.equal(loops[loops.length - 1], -50_000);
});

// #189 item 4: edge tests the review asked for.
test("non-looping clip started at its end fires an event placed exactly at the end once", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 2,
    loop: false,
    startTime: 2,
    events: [{ clip: "c", name: "end", time: 2, payload: {} }],
  });
  // Forward from the end: the start point is included once; the head cannot move further.
  const first = tracker.advance(0.5);
  assert.deepEqual(first.fired.map((fire) => fire.name), ["end"]);
  assert.equal(first.finished, true);
  assert.equal(tracker.advance(0.5).fired.length, 0);
});

test("seek then reverse playback across several loops fires each crossing in order", () => {
  const tracker = boundaryTracker(1, 0.25);
  tracker.seek(10.5); // loop 10, t=0.5
  const result = tracker.advance(-3);
  assert.deepEqual(
    result.fired.map((fire) => fire.loop),
    [10, 9, 8],
  );
  assert.deepEqual(
    result.fired.map((fire) => fire.position),
    [10.25, 9.25, 8.25],
  );
  assert.equal(tracker.time, 0.5);
  assert.equal(tracker.position, 7.5);
});

test("a huge delta over mostly empty loops reports truncated when the iteration budget runs out", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: true,
    maxFiresPerAdvance: 4,
    events: [{ clip: "c", name: "e", time: 0.5, payload: {} }],
  });
  const result = tracker.advance(1_000_000);
  assert.equal(result.truncated, true);
  assert.ok(result.fired.length <= 4);
  // The head still moved the full distance.
  assert.equal(tracker.position, 1_000_000);
  assert.equal(tracker.time, 0);
});
