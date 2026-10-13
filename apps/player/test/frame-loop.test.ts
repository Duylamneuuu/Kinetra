import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFrameLoop } from "../src/frame-loop.js";

function harness(tick: (delta: number) => void, onError: (error: unknown) => void = () => undefined) {
  const scheduled: Array<(now: number) => void> = [];
  const loop = createFrameLoop({
    initialTime: 1000,
    schedule: (callback) => {
      scheduled.push(callback);
    },
    tick,
    onError,
  });
  const runNext = (now: number): void => {
    const next = scheduled.shift();
    assert.ok(next, "a frame must be scheduled");
    next(now);
  };
  return { loop, scheduled, runNext };
}

describe("player frame loop", () => {
  it("keeps scheduling frames after a tick throws and reports the error", () => {
    const errors: unknown[] = [];
    const deltas: number[] = [];
    let calls = 0;
    const { loop, scheduled, runNext } = harness(
      (delta) => {
        calls += 1;
        if (calls === 1) throw new Error("render failed");
        deltas.push(delta);
      },
      (error) => errors.push(error),
    );

    loop.start();
    runNext(1016);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "render failed");
    assert.equal(scheduled.length, 1, "the next frame is scheduled even though the tick threw");

    runNext(1032);
    assert.equal(deltas.length, 1);
    assert.ok(Math.abs((deltas[0] ?? 0) - 0.016) < 1e-9);
    assert.equal(scheduled.length, 1);
  });

  it("keeps running when the error reporter itself throws", () => {
    const { loop, scheduled, runNext } = harness(
      () => {
        throw new Error("tick");
      },
      () => {
        throw new Error("reporter");
      },
    );
    loop.start();
    runNext(1016);
    assert.equal(scheduled.length, 1);
  });

  it("clamps long pauses and backwards timestamps", () => {
    const deltas: number[] = [];
    const { loop, runNext } = harness((delta) => deltas.push(delta));
    loop.start();
    runNext(61000); // one minute hidden tab
    runNext(60000); // clock went backwards
    assert.deepEqual(deltas, [0.1, 0]);
  });

  it("never hands a non-finite delta to tick", () => {
    const deltas: number[] = [];
    const { loop, runNext } = harness((delta) => deltas.push(delta));
    loop.start();
    runNext(Number.NaN);
    runNext(1016);
    runNext(Number.POSITIVE_INFINITY);
    assert.ok(deltas.every((delta) => Number.isFinite(delta) && delta >= 0 && delta <= 0.1));
    assert.equal(deltas.length, 3);
  });
});
