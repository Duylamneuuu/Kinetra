import assert from "node:assert/strict";
import test from "node:test";

import { startOrbRunSimulation } from "../src/index.js";

// A step count is a count of whole fixed steps. Before this guard `advance(2.5)` ran three steps,
// `advance(NaN)` ran none and `advance(Infinity)` never returned.

test("advance refuses a step count that is not an integer >= 0, before any step runs", async () => {
  const simulation = await startOrbRunSimulation();
  const revision = simulation.stateRevision;
  for (const bad of [2.5, 0.1, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => simulation.advance(bad), RangeError, `advance(${String(bad)})`);
  }
  assert.equal(simulation.step, 0, "a refused call ran nothing");
  assert.equal(simulation.stateRevision, revision, "and changed nothing");
  await simulation.dispose();
});

test("advance accepts zero (a no-op) and whole counts, and the default is one step", async () => {
  const simulation = await startOrbRunSimulation();
  simulation.advance(0);
  assert.equal(simulation.step, 0);
  simulation.advance();
  assert.equal(simulation.step, 1);
  simulation.advance(4);
  assert.equal(simulation.step, 5);
  await simulation.dispose();
});

// #500: the predicate is checked after the last allowed step too, so a state that becomes true
// exactly on step `maxSteps` is reported as reached.
test("advanceUntil reports a predicate that becomes true exactly on the last allowed step", async () => {
  const simulation = await startOrbRunSimulation();
  assert.equal(simulation.advanceUntil(() => simulation.step >= 3, 3), true);
  assert.equal(simulation.step, 3, "ran exactly the budget, no more");
  assert.equal(simulation.advanceUntil(() => simulation.step >= 5, 1), false, "one step short is still false");
  assert.equal(simulation.step, 4);
  assert.equal(simulation.advanceUntil(() => simulation.step >= 5, 1), true);
  assert.equal(simulation.step, 5);
  await simulation.dispose();
});

test("advanceUntil with a zero budget answers from the current state without stepping", async () => {
  const simulation = await startOrbRunSimulation();
  assert.equal(simulation.advanceUntil(() => true, 0), true, "already true -> true");
  assert.equal(simulation.advanceUntil(() => simulation.step >= 1, 0), false, "not yet true -> false");
  assert.equal(simulation.step, 0, "a zero budget runs nothing");
  await simulation.dispose();
});

test("advanceUntil refuses an unbounded or fractional budget instead of looping forever", async () => {
  const simulation = await startOrbRunSimulation();
  for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -3, 1.5]) {
    assert.throws(() => simulation.advanceUntil(() => false, bad), RangeError, `advanceUntil(.., ${String(bad)})`);
  }
  assert.equal(simulation.step, 0);
  assert.equal(simulation.advanceUntil(() => simulation.step >= 3, 10), true);
  assert.equal(simulation.step, 3);
  assert.equal(simulation.advanceUntil(() => false, 4), false, "a spent budget reports false");
  assert.equal(simulation.step, 7);
  assert.equal(simulation.advanceUntil(() => false, 0), false, "a zero budget runs nothing");
  assert.equal(simulation.step, 7);
  await simulation.dispose();
});
