import assert from "node:assert/strict";
import test from "node:test";

import {
  ORB_RUN_ACTION,
  orbRunAnimator,
  startOrbRunSimulation,
  type GroundHeightFn,
} from "../src/index.js";

// Regression tests for #252 item 1: the animator and other step listeners are read-only
// observers, so nothing they do wrong may change or abort the simulation.

test("a ground function that fails on its Nth call never escapes the step, whichever call N is", async () => {
  for (let failingCall = 1; failingCall <= 14; failingCall += 1) {
    let calls = 0;
    const ground: GroundHeightFn = () => {
      calls += 1;
      if (calls === failingCall) throw new Error(`terrain call ${String(failingCall)}`);
      return 0;
    };
    const simulation = await startOrbRunSimulation(undefined, { ground });
    const animator = orbRunAnimator(simulation);
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    assert.doesNotThrow(() => simulation.advance(5), `call ${String(failingCall)} must not abort advance`);
    assert.equal(simulation.step, 5);
    const pose = animator.state();
    assert.equal(pose.step, 5, "the pose still tracks the step");
    assert.equal(animator.failures().length, 1, `exactly the failed pose is counted (call ${String(failingCall)})`);
    assert.match(animator.failures()[0]!.message, /terrain call/);
    await simulation.dispose();
  }
});

test("each pose samples the ground exactly three times (base, left, right), so a stateful ground stays consistent", async () => {
  let calls = 0;
  const seen: Array<[number, number]> = [];
  const ground: GroundHeightFn = (x, z) => {
    calls += 1;
    seen.push([x, z]);
    return 0;
  };
  const simulation = await startOrbRunSimulation(undefined, { ground });
  const animator = orbRunAnimator(simulation);
  assert.equal(calls, 3, "one pose at construction");
  simulation.advance(4);
  assert.equal(calls, 3 * 5, "one pose per step");
  assert.equal(animator.state().failedCount, 0);
  // base, left and right all sample the same z.
  for (const [, z] of seen) assert.equal(z, seen[0]![1]);
  await simulation.dispose();
});

test("a failing step listener is logged once, does not abort advance, and does not starve later listeners", async () => {
  const simulation = await startOrbRunSimulation();
  let boom = 0;
  let later = 0;
  simulation.onStep(() => {
    boom += 1;
    throw new Error("listener exploded");
  });
  simulation.onStep(() => {
    later += 1;
  });
  const before = simulation.stateRevision;
  assert.doesNotThrow(() => simulation.advance(5));
  assert.equal(simulation.step, 5);
  assert.equal(simulation.stateRevision, before + 5);
  assert.equal(boom, 5, "the failing listener keeps being called");
  assert.equal(later, 5, "listeners after it still run on every step");
  const warnings = simulation.logs("simulation.stepListenerFailed");
  assert.equal(warnings.length, 1, "logged once per listener, not once per step");
  assert.equal(warnings[0]!.level, "warning");
  assert.equal(warnings[0]!.data?.message, "listener exploded");
  await simulation.dispose();
});

test("a listener that throws a non-Error is still reported", async () => {
  const simulation = await startOrbRunSimulation();
  simulation.onStep(() => {
    throw "plain string";
  });
  simulation.advance(2);
  assert.equal(simulation.step, 2);
  assert.equal(simulation.logs("simulation.stepListenerFailed")[0]!.data?.message, "plain string");
  await simulation.dispose();
});
