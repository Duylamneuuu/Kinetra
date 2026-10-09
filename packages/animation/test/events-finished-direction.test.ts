import assert from "node:assert/strict";
import test from "node:test";

import { createClipEventTracker, type ClipAnimationEvent } from "../src/events.js";

const events: ClipAnimationEvent[] = [
  { clip: "c", time: 0, name: "head", payload: {} },
  { clip: "c", time: 1, name: "tail", payload: {} },
];

test("finished: reverse playback already parked at 0 reports finished, like forward parked at the end", () => {
  const reverse = createClipEventTracker({ clip: "c", duration: 1, loop: false, events }).tracker;
  const parked = reverse.advance(-0.25);
  assert.equal(parked.time, 0);
  assert.equal(parked.finished, true, "reverse head standing at 0 has reached the end it moves toward");

  const forward = createClipEventTracker({ clip: "c", duration: 1, loop: false, startTime: 1, events }).tracker;
  assert.equal(forward.advance(0.25).finished, true);
});

test("finished: reverse step that stays at 0 after having reached it keeps reporting finished", () => {
  const { tracker } = createClipEventTracker({ clip: "c", duration: 2, loop: false, startTime: 1, events });
  assert.equal(tracker.advance(-5).finished, true);
  const again = tracker.advance(-1);
  assert.equal(again.time, 0);
  assert.equal(again.finished, true);
  assert.deepEqual(again.fired, []);
});

test("finished: moving away from the end or looping never reports finished", () => {
  const { tracker } = createClipEventTracker({ clip: "c", duration: 1, loop: false, events });
  // Parked at 0 but moving forward by a positive step is not finished.
  assert.equal(tracker.advance(0.25).finished, false);
  const looping = createClipEventTracker({ clip: "c", duration: 1, loop: true, events }).tracker;
  assert.equal(looping.advance(-0.25).finished, false);
  assert.equal(looping.advance(0.25).finished, false);
});
