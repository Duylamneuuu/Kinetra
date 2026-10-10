/**
 * Event tracker hardening (#189): the public constructor is safe on its own, and events that
 * can never fire are reported instead of vanishing silently.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ClipEventTracker,
  createClipEventTracker,
  type ClipAnimationEvent,
} from "../src/events.js";

const ev = (clip: string, time: number, name = "e"): ClipAnimationEvent => ({ clip, time, name, payload: {} });

test("new ClipEventTracker with an unusable duration is inert and keeps time finite", () => {
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const tracker = new ClipEventTracker({ clip: "a", duration, events: [], loop: true }, [ev("a", 0)]);
    const result = tracker.advance(1);
    assert.deepEqual(result.fired, [], `duration ${duration}`);
    assert.ok(Number.isFinite(tracker.time), `time finite for duration ${duration}`);
    assert.ok(Number.isFinite(result.position));
    assert.ok(Number.isFinite(tracker.duration));
  }
});

test("new ClipEventTracker ignores foreign-clip and out-of-range events and sorts the rest", () => {
  const tracker = new ClipEventTracker({ clip: "a", duration: 2, events: [], loop: false }, [
    ev("a", 1.5, "late"),
    ev("b", 0.5, "other"),
    ev("a", 3, "beyond"),
    ev("a", Number.NaN, "nan"),
    ev("a", 0.5, "early"),
  ]);
  const names = tracker.advance(5).fired.map((f) => f.name);
  assert.deepEqual(names, ["early", "late"]);
});

test("new ClipEventTracker falls back to the default cap for an invalid maxFiresPerAdvance", () => {
  for (const cap of [0, -3, 1.5, Number.NaN]) {
    const tracker = new ClipEventTracker(
      { clip: "a", duration: 1, events: [], loop: false, maxFiresPerAdvance: cap },
      [ev("a", 0.5)],
    );
    const result = tracker.advance(1);
    assert.equal(result.fired.length, 1, `cap ${cap}`);
    assert.equal(result.truncated, false);
  }
});

test("createClipEventTracker warns about events beyond the clip duration", () => {
  const { tracker, diagnostics } = createClipEventTracker({
    clip: "a",
    duration: 1,
    events: [ev("a", 0.5), ev("a", 2, "tooLate"), ev("b", 9, "otherClipIsNotCounted")],
    loop: false,
  });
  const warning = diagnostics.find((d) => d.code === "animation.events.beyondDuration");
  assert.ok(warning, "beyondDuration diagnostic");
  assert.equal(warning!.severity, "warning");
  assert.match(warning!.message, /1 event/);
  assert.deepEqual(tracker.advance(1).fired.map((f) => f.name), ["e"]);
});

test("createClipEventTracker stays silent when every event of the clip is in range", () => {
  const { diagnostics } = createClipEventTracker({
    clip: "a",
    duration: 1,
    events: [ev("a", 0), ev("a", 1), ev("b", 9)],
    loop: true,
  });
  assert.deepEqual(diagnostics, []);
});
