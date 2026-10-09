import assert from "node:assert/strict";
import test from "node:test";

import { singleFlight } from "../src/single-flight.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a second call while the first is pending joins it and runs the action once", async () => {
  const gate = deferred();
  const calls: boolean[] = [];
  const guarded = singleFlight(async (fromSave: boolean) => {
    calls.push(fromSave);
    await gate.promise;
  });

  const first = guarded(false);
  const second = guarded(true);
  const third = guarded(false);
  assert.equal(second, first, "joining calls get the same promise");
  assert.equal(third, first);
  assert.deepEqual(calls, [false], "only the first call's arguments are used");

  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, [false]);
});

test("after the pending call settles the action can run again (deliberate restart)", async () => {
  let runs = 0;
  const guarded = singleFlight(async () => {
    runs += 1;
  });
  await guarded();
  await guarded();
  await guarded();
  assert.equal(runs, 3);
});

test("a rejection reaches every joined caller and releases the guard", async () => {
  const gate = deferred();
  let runs = 0;
  const guarded = singleFlight(async () => {
    runs += 1;
    if (runs === 1) await gate.promise;
  });

  const first = guarded();
  const second = guarded();
  gate.reject(new Error("runtime failed to start"));
  await assert.rejects(first, /runtime failed to start/);
  await assert.rejects(second, /runtime failed to start/);

  await guarded();
  assert.equal(runs, 2, "a failed start must not wedge the guard");
});

test("a synchronous throw becomes a rejection and releases the guard", async () => {
  let runs = 0;
  const guarded = singleFlight((): Promise<void> => {
    runs += 1;
    if (runs === 1) throw new Error("sync boom");
    return Promise.resolve();
  });

  await assert.rejects(guarded(), /sync boom/);
  await guarded();
  assert.equal(runs, 2);
});

test("calls made in the same tick as a settle start a fresh run", async () => {
  const gates = [deferred(), deferred()];
  let runs = 0;
  const guarded = singleFlight(async () => {
    const gate = gates[runs++];
    await gate?.promise;
  });

  const first = guarded();
  gates[0]?.resolve();
  await first;
  const next = guarded();
  assert.notEqual(next, first);
  assert.equal(runs, 2);
  gates[1]?.resolve();
  await next;
});
