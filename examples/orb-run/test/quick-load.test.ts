import assert from "node:assert/strict";
import test from "node:test";

import {
  ORB_RUN_WINNING_ROUTE,
  captureOrbRunSave,
  driveOrbRunFuzz,
  orbRunAudio,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type HeadlessSceneSimulation,
  type OrbRunFuzzStrategy,
  type OrbRunSaveData,
} from "../src/index.js";

/**
 * Quick-load: restoring a save into a simulation that has already moved on. The clock has to follow the restored
 * state (`step`, `elapsedSeconds`, the audio clock), otherwise the game state says "step 40" while the simulation
 * keeps counting from the abandoned timeline.
 */

function roundTrip(save: OrbRunSaveData): OrbRunSaveData {
  return JSON.parse(JSON.stringify(save)) as OrbRunSaveData;
}

async function playRoute(simulation: HeadlessSceneSimulation, from: number): Promise<void> {
  for (const target of ORB_RUN_WINNING_ROUTE.slice(from)) walkTo(simulation, target);
}

test("quick-load into a run that moved on rewinds the clock with the state", async () => {
  const first = await startOrbRunSimulation();
  try {
    for (const target of ORB_RUN_WINNING_ROUTE.slice(0, 2)) walkTo(first, target);
    const save = roundTrip(captureOrbRunSave(first));
    const midSummary = summarizeOrbRun(first);
    await playRoute(first, 2);
    const finalSave = captureOrbRunSave(first);
    assert.equal(summarizeOrbRun(first).status, "won");
    assert.ok(first.step > save.step);

    await restoreOrbRunSave(first, save);
    assert.equal(first.step, save.step, "simulation.step follows the save");
    assert.equal(first.elapsedSeconds, save.step * first.fixedDeltaSeconds);
    assert.deepEqual(summarizeOrbRun(first), midSummary);
    assert.deepEqual(captureOrbRunSave(first), save, "capture after restore is the save, byte for byte");
    assert.equal(orbRunAudio(first).state().initialized, true);
    assert.equal(orbRunAudio(first).failures().length, 0);

    // Playing on from the restored point reproduces the first timeline exactly (same step, same state).
    await playRoute(first, 2);
    assert.deepEqual(captureOrbRunSave(first), finalSave);
  } finally {
    await first.dispose();
  }
});

test("quick-load round trip is the identity at any step of any fuzzed run", async () => {
  const strategies: OrbRunFuzzStrategy[] = ["random", "seek", "mixed"];
  for (let seed = 1; seed <= 12; seed += 1) {
    const simulation = await startOrbRunSimulation();
    try {
      driveOrbRunFuzz(simulation, { seed, steps: 120 + seed * 7, strategy: strategies[seed % 3]! });
      const save = roundTrip(captureOrbRunSave(simulation));
      driveOrbRunFuzz(simulation, { seed: seed + 100, steps: 200, strategy: strategies[(seed + 1) % 3]! });
      assert.ok(simulation.step > save.step);

      await restoreOrbRunSave(simulation, save);
      assert.equal(simulation.step, save.step, `seed ${seed}: step`);
      assert.equal(summarizeOrbRun(simulation).step, save.step, `seed ${seed}: summary step`);
      assert.deepEqual(captureOrbRunSave(simulation), save, `seed ${seed}: capture(restore(save)) === save`);
    } finally {
      await simulation.dispose();
    }
  }
});

test("quick-loading a later save moves the clock forward too, and a refused save leaves the clock alone", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    driveOrbRunFuzz(simulation, { seed: 7, steps: 300, strategy: "seek" });
    const later = roundTrip(captureOrbRunSave(simulation));

    const earlier = await startOrbRunSimulation();
    try {
      driveOrbRunFuzz(earlier, { seed: 7, steps: 300, strategy: "seek" });
      assert.deepEqual(captureOrbRunSave(earlier), later, "same seed, same run");
      // Same timeline, so loading the later save into a fresh sim jumps its clock straight to step 300.
      const fresh = await startOrbRunSimulation();
      try {
        await restoreOrbRunSave(fresh, later);
        assert.equal(fresh.step, 300);
        assert.deepEqual(captureOrbRunSave(fresh), later);

        const before = fresh.step;
        await assert.rejects(restoreOrbRunSave(fresh, { ...later, step: -1 }), /step/);
        assert.equal(fresh.step, before, "a refused save leaves the clock alone");
      } finally {
        await fresh.dispose();
      }
    } finally {
      await earlier.dispose();
    }
  } finally {
    await simulation.dispose();
  }
});

test("restoreStep takes any non-negative integer and refuses the rest", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    simulation.advance(10);
    simulation.restoreStep(4);
    assert.equal(simulation.step, 4);
    simulation.restoreStep(0);
    assert.equal(simulation.step, 0);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => simulation.restoreStep(bad), RangeError);
    }
    assert.equal(simulation.step, 0);
  } finally {
    await simulation.dispose();
  }
});
