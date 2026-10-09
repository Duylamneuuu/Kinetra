import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_FIRES_PER_ADVANCE,
  MAX_ANIMATION_EVENTS,
  createClipEventTracker,
  normalizeAnimationEvents,
  parseAnimationEventsText,
  type AnimationEventFire,
  type ClipAnimationEvent,
} from "../src/events.js";
import * as rootExports from "../src/index.js";

function ev(clip: string, time: number, name: string, payload: Record<string, unknown> = {}): ClipAnimationEvent {
  return { clip, time, name, payload };
}

function summarize(fires: readonly AnimationEventFire[]): string[] {
  return fires.map((fire) => `${fire.name}@${fire.position}#${fire.loop}`);
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
  return result.diagnostics.map((d) => d.code);
}

// --- normalization --------------------------------------------------------------------

test("normalize: accepts valid events, sorts by clip/time/input order, clones payloads", () => {
  const raw = [
    { clip: "walk", time: 0.5, name: "b", payload: { foot: "left", nested: { n: [1, 2] } } },
    { clip: "run", time: 0.25, name: "step" },
    { clip: "walk", time: 0.5, name: "a" },
    { clip: "walk", time: 0.1, name: "first" },
  ];
  const result = normalizeAnimationEvents(raw, { walk: 1, run: 1 });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.events.map((e) => `${e.clip}:${e.time}:${e.name}`),
    ["run:0.25:step", "walk:0.1:first", "walk:0.5:b", "walk:0.5:a"],
  );
  assert.deepEqual(result.events[0]?.payload, {});
  const rawPayload = raw[0]!.payload as { foot: string };
  rawPayload.foot = "mutated";
  assert.equal(result.events[2]?.payload.foot, "left", "payload is a deep copy");
});

test("normalize: structured diagnostics for every kind of bad entry, valid ones kept", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const result = normalizeAnimationEvents(
    [
      null,
      "text",
      { clip: "", time: 0, name: "x" },
      { clip: "ghost", time: 0, name: "x" },
      { clip: "walk", time: -1, name: "x" },
      { clip: "walk", time: Number.NaN, name: "x" },
      { clip: "walk", time: "0.5", name: "x" },
      { clip: "walk", time: 2, name: "x" },
      { clip: "walk", time: 0, name: "" },
      { clip: "walk", time: 0, name: "a\nb" },
      { clip: "walk", time: 0, name: "n".repeat(129) },
      { clip: "walk", time: 0, name: "x", payload: [1] },
      { clip: "walk", time: 0, name: "x", payload: { v: Number.POSITIVE_INFINITY } },
      { clip: "walk", time: 0, name: "x", payload: { f: () => 1 } },
      { clip: "walk", time: 0, name: "x", payload: { b: 10n } },
      { clip: "walk", time: 0, name: "x", payload: cyclic },
      { clip: "walk", time: 0, name: "x", payload: { big: "z".repeat(5000) } },
      { clip: "walk", time: 0.5, name: "ok" },
    ],
    { walk: 1 },
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.code.replace("animation.events.", "")),
    [
      "invalidEvent",
      "invalidEvent",
      "invalidClip",
      "unknownClip",
      "invalidTime",
      "invalidTime",
      "invalidTime",
      "timeOutOfRange",
      "invalidName",
      "invalidName",
      "invalidName",
      "invalidPayload",
      "invalidPayload",
      "invalidPayload",
      "invalidPayload",
      "invalidPayload",
      "payloadTooLarge",
    ],
  );
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.severity, "error");
    assert.ok(diagnostic.message.length > 0 && diagnostic.remediation.length > 0);
    assert.equal(typeof diagnostic.index, "number");
  }
  assert.deepEqual(result.events.map((e) => e.name), ["ok"]);
});

test("normalize: not-an-array inputs never throw", () => {
  for (const input of [undefined, null, 1, "x", {}, true, Symbol("s")]) {
    const result = normalizeAnimationEvents(input);
    assert.deepEqual(codes(result), ["animation.events.notArray"]);
    assert.deepEqual(result.events, []);
  }
});

test("normalize: without clip durations only structure is checked; duplicates warn but are kept", () => {
  const result = normalizeAnimationEvents([
    { clip: "any", time: 9999, name: "late" },
    { clip: "any", time: 1, name: "dup" },
    { clip: "any", time: 1, name: "dup" },
  ]);
  assert.deepEqual(codes(result), ["animation.events.duplicate"]);
  assert.equal(result.diagnostics[0]?.severity, "warning");
  assert.equal(result.diagnostics[0]?.index, 2);
  assert.equal(result.events.length, 3);
});

test("normalize: clip duration lookup is own-property only (Map and record)", () => {
  const record = normalizeAnimationEvents([{ clip: "toString", time: 0, name: "x" }], {});
  assert.deepEqual(codes(record), ["animation.events.unknownClip"]);
  const map = normalizeAnimationEvents([{ clip: "m", time: 1, name: "x" }], new Map([["m", 1]]));
  assert.deepEqual(codes(map), []);
});

test("normalize: caps the number of events and keeps the first ones", () => {
  const raw = Array.from({ length: MAX_ANIMATION_EVENTS + 5 }, (_, i) => ({ clip: "c", time: i, name: "e" }));
  const result = normalizeAnimationEvents(raw);
  assert.equal(result.events.length, MAX_ANIMATION_EVENTS);
  assert.ok(codes(result).includes("animation.events.tooMany"));
});

test("normalize: payload key __proto__ from JSON survives as data and does not pollute", () => {
  const parsed = parseAnimationEventsText(
    '[{"clip":"c","time":0,"name":"n","payload":{"__proto__":{"admin":true},"x":1}}]',
    { c: 1 },
  );
  assert.deepEqual(parsed.diagnostics, []);
  const payload = parsed.events[0]?.payload as Record<string, unknown>;
  assert.ok(Object.prototype.hasOwnProperty.call(payload, "__proto__"));
  assert.equal(Object.getPrototypeOf(payload), Object.prototype);
  assert.equal(({} as { admin?: boolean }).admin, undefined);
  assert.deepEqual(Object.keys(payload).sort(), ["__proto__", "x"]);
});

test("parse text: malformed JSON becomes a diagnostic", () => {
  const result = parseAnimationEventsText("[{");
  assert.deepEqual(codes(result), ["animation.events.invalidJson"]);
  assert.deepEqual(result.events, []);
});

// --- tracker --------------------------------------------------------------------------

test("tracker: non-looping forward fires each event once, including the start point", () => {
  const { tracker, diagnostics } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: false,
    events: [ev("c", 0, "start"), ev("c", 0.5, "mid"), ev("c", 1, "end"), ev("other", 0.25, "nope")],
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(summarize(tracker.advance(0.5).fired), ["start@0#0", "mid@0.5#0"]);
  const last = tracker.advance(0.5);
  assert.deepEqual(summarize(last.fired), ["end@1#0"]);
  assert.equal(last.finished, true);
  const after = tracker.advance(3);
  assert.deepEqual(after.fired, []);
  assert.equal(after.time, 1);
});

test("tracker: reverse non-looping uses [to, from) and fires in descending order", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: false,
    startTime: 1,
    events: [ev("c", 0, "a"), ev("c", 0.5, "b"), ev("c", 1, "c")],
  });
  assert.deepEqual(summarize(tracker.advance(-0.5).fired), ["c@1#0", "b@0.5#0"]);
  const end = tracker.advance(-5);
  assert.deepEqual(summarize(end.fired), ["a@0#0"]);
  assert.equal(end.finished, true);
  assert.deepEqual(tracker.advance(-1).fired, []);
});

test("tracker: looping fires once per crossing across wraps and multi-loop steps", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 2,
    loop: true,
    startTime: 1.5,
    events: [ev("c", 0.5, "a"), ev("c", 1, "b")],
  });
  // 1.5 -> 2.5 wraps once: crosses a at 2.5 only.
  assert.deepEqual(summarize(tracker.advance(1).fired), ["a@2.5#1"]);
  // 2.5 -> 7: loops 1(b@3), 2(a@4.5,b@5), 3(a@6.5)
  const big = tracker.advance(4.5);
  assert.deepEqual(summarize(big.fired), ["b@3#1", "a@4.5#2", "b@5#2", "a@6.5#3", "b@7#3"]);
  assert.equal(big.position, 7);
  assert.equal(big.time, 1);
  assert.equal(big.finished, false);
});

test("tracker: events at duration and at 0 both fire at the wrap; start point belongs to its own iteration", () => {
  const events = [ev("c", 0, "head"), ev("c", 1, "tail")];
  const { tracker } = createClipEventTracker({ clip: "c", duration: 1, loop: true, events });
  // first move includes the start point: head@0 only, not the previous iteration's tail
  assert.deepEqual(summarize(tracker.advance(0.5).fired), ["head@0#0"]);
  assert.deepEqual(summarize(tracker.advance(0.5).fired), ["tail@1#0", "head@1#1"]);

  const reverse = createClipEventTracker({ clip: "c", duration: 1, loop: true, startTime: 1, events }).tracker;
  // startTime == duration is time 0 of iteration 1, so only its head fires, not iteration 0's tail
  assert.deepEqual(summarize(reverse.advance(-0.25).fired), ["head@1#1"]);
  // arriving at the wrap point fires both sides, higher iteration first
  assert.deepEqual(summarize(reverse.advance(-0.75).fired), ["head@0#0", "tail@0#-1"]);
});

test("tracker: reverse looping runs through negative iterations", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: true,
    startTime: 0.25,
    events: [ev("c", 0.5, "m")],
  });
  tracker.advance(-0.25); // no events between 0.25 and 0
  const result = tracker.advance(-2);
  assert.deepEqual(summarize(result.fired), ["m@-0.5#-1", "m@-1.5#-2"]);
  assert.equal(result.position, -2);
  assert.equal(result.time, 0);
});

test("tracker: payload is copied per firing", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: true,
    events: [ev("c", 0.5, "m", { list: [1, 2] })],
  });
  const fires = tracker.advance(2.5).fired;
  assert.equal(fires.length, 3);
  const firstList = fires[0]!.payload.list as number[];
  firstList.push(99);
  assert.deepEqual(fires[1]?.payload, { list: [1, 2] });
  assert.deepEqual(fires[2]?.payload, { list: [1, 2] });
});

test("tracker: zero, NaN and infinite deltas move nothing and fire nothing; seek and reset", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: false,
    events: [ev("c", 0, "s"), ev("c", 0.5, "m")],
  });
  for (const delta of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = tracker.advance(delta);
    assert.deepEqual(result.fired, []);
    assert.equal(result.position, 0);
  }
  // a rejected delta must not consume the start-point inclusion
  assert.deepEqual(summarize(tracker.advance(0.25).fired), ["s@0#0"]);
  tracker.seek(0.75);
  assert.equal(tracker.time, 0.75);
  assert.deepEqual(tracker.advance(0.25).fired, [], "seek crosses nothing; m is behind the head");
  tracker.reset();
  assert.equal(tracker.position, 0);
  assert.deepEqual(summarize(tracker.advance(1).fired), ["s@0#0", "m@0.5#0"]);
  tracker.seek(Number.NaN);
  assert.equal(tracker.position, 1, "NaN seek is ignored");
});

test("tracker: unusable duration yields an inert tracker plus a diagnostic, never a throw", () => {
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { tracker, diagnostics } = createClipEventTracker({
      clip: "c",
      duration,
      loop: true,
      events: [ev("c", 0, "x")],
    });
    assert.deepEqual(diagnostics.map((d) => d.code), ["animation.events.invalidDuration"]);
    assert.deepEqual(tracker.advance(5).fired, []);
  }
  const capped = createClipEventTracker({ clip: "c", duration: 1, loop: true, events: [], maxFiresPerAdvance: 0 });
  assert.deepEqual(capped.diagnostics.map((d) => d.code), ["animation.events.invalidCap"]);
});

test("tracker: events outside [0, duration] are ignored defensively", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: true,
    events: [ev("c", 5, "far"), ev("c", -1, "neg"), ev("c", Number.NaN, "nan"), ev("c", 0.5, "ok")],
  });
  assert.deepEqual(summarize(tracker.advance(1).fired), ["ok@0.5#0"]);
});

test("tracker: huge steps are capped, flagged and still terminate quickly", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 0.01,
    loop: true,
    maxFiresPerAdvance: 3,
    events: [ev("c", 0.005, "tick")],
  });
  const started = Date.now();
  const result = tracker.advance(1e12);
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.fired.length, 3);
  assert.equal(result.position, 1e12);

  const defaults = createClipEventTracker({ clip: "c", duration: 1, loop: true, events: [ev("c", 0.5, "t")] }).tracker;
  const many = defaults.advance(DEFAULT_MAX_FIRES_PER_ADVANCE + 10);
  assert.equal(many.fired.length, DEFAULT_MAX_FIRES_PER_ADVANCE);
  assert.equal(many.truncated, true);

  // an absurd step with no hits at all (float precision) still terminates
  const sparse = createClipEventTracker({ clip: "c", duration: 1e-9, loop: true, events: [ev("c", 5e-10, "t")] }).tracker;
  const t0 = Date.now();
  sparse.advance(1e15);
  assert.ok(Date.now() - t0 < 1000);
});

test("tracker: exactly-at-boundary steps neither miss nor double-fire", () => {
  const { tracker } = createClipEventTracker({
    clip: "c",
    duration: 1,
    loop: false,
    events: [ev("c", 0.25, "q"), ev("c", 0.5, "h")],
  });
  assert.deepEqual(summarize(tracker.advance(0.25).fired), ["q@0.25#0"]);
  assert.deepEqual(summarize(tracker.advance(0.25).fired), ["h@0.5#0"]);
  assert.deepEqual(tracker.advance(0.25).fired, []);
});

// --- property: step partition invariance ---------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: fired events are identical for any partition of the same movement (forward and reverse)", () => {
  const unit = 1 / 16;
  for (let seed = 1; seed <= 120; seed += 1) {
    const rand = makeRng(seed);
    const duration = (1 + Math.floor(rand() * 32)) * unit;
    const loop = rand() < 0.6;
    const events: ClipAnimationEvent[] = [];
    const count = Math.floor(rand() * 7);
    for (let i = 0; i < count; i += 1) {
      const time = Math.floor(rand() * (duration / unit + 1)) * unit;
      events.push(ev("c", Math.min(time, duration), `e${i}`));
    }
    const direction = rand() < 0.5 ? 1 : -1;
    const startTime = Math.floor(rand() * (duration / unit + 1)) * unit;
    const steps: number[] = [];
    const stepCount = 1 + Math.floor(rand() * 12);
    for (let i = 0; i < stepCount; i += 1) steps.push(Math.floor(rand() * 40) * unit * direction);
    const total = steps.reduce((sum, s) => sum + s, 0);

    const make = () =>
      createClipEventTracker({ clip: "c", duration, loop, events, startTime, maxFiresPerAdvance: 100000 }).tracker;

    const whole = make();
    const wholeResult = whole.advance(total);
    const partitioned = make();
    const pieces: AnimationEventFire[] = [];
    for (const step of steps) pieces.push(...partitioned.advance(step).fired);

    assert.deepEqual(summarize(pieces), summarize(wholeResult.fired), `seed ${seed}`);
    assert.equal(partitioned.position, whole.position, `seed ${seed} position`);

    // a second, finer partition (split every step in half) agrees too
    const fine = make();
    const finePieces: AnimationEventFire[] = [];
    for (const step of steps) {
      finePieces.push(...fine.advance(step / 2).fired);
      finePieces.push(...fine.advance(step / 2).fired);
    }
    assert.deepEqual(summarize(finePieces), summarize(wholeResult.fired), `seed ${seed} fine`);
  }
});

test("property: looping fire counts match a closed-form crossing count", () => {
  const unit = 1 / 8;
  for (let seed = 200; seed < 260; seed += 1) {
    const rand = makeRng(seed);
    const duration = (2 + Math.floor(rand() * 16)) * unit;
    // keep strictly inside (0, duration) so the closed form is a plain floor difference
    const time = (1 + Math.floor(rand() * (duration / unit - 1))) * unit;
    const { tracker } = createClipEventTracker({ clip: "c", duration, loop: true, events: [ev("c", time, "x")] });
    const advance = Math.floor(rand() * 200) * unit + unit;
    const result = tracker.advance(advance);
    const expected = Math.floor((advance - time) / duration) + 1;
    assert.equal(result.fired.length, Math.max(0, expected), `seed ${seed}`);
  }
});

// --- exports --------------------------------------------------------------------------

test("package root re-exports the events API", () => {
  assert.equal(rootExports.createClipEventTracker, createClipEventTracker);
  assert.equal(rootExports.normalizeAnimationEvents, normalizeAnimationEvents);
  assert.equal(rootExports.parseAnimationEventsText, parseAnimationEventsText);
});
