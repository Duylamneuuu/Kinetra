import assert from "node:assert/strict";
import test from "node:test";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_EVENT,
  ORB_RUN_MAX_SAVE_SECONDS,
  ORB_RUN_ORB_IDS,
  ORB_RUN_STOWED_Y,
  ORB_RUN_WINNING_ROUTE,
  OrbRunRestoreError,
  OrbRunSaveError,
  captureOrbRunSave,
  orbRunAnimator,
  orbRunAudio,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type HeadlessSceneSimulation,
  type OrbRunSaveData,
} from "../src/index.js";

/**
 * Slice 30 (issues #480 and #482): what a restore leaves behind.
 *  - #480: after a quick-load, log/event/audio-cue entries of the abandoned timeline are gone, so steps never go back.
 *  - #482: one stowed-height constant, a rollback that reports its own failure, an animator that follows a rollback,
 *    and a ceiling on the step a save may claim.
 */

function roundTrip(save: OrbRunSaveData): OrbRunSaveData {
  return JSON.parse(JSON.stringify(save)) as OrbRunSaveData;
}

function assertNonDecreasing(steps: number[], label: string): void {
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(steps[index]! >= steps[index - 1]!, `${label}: step ${steps[index]} follows ${steps[index - 1]} at entry ${index}`);
  }
}

async function playToMidRun(simulation: HeadlessSceneSimulation): Promise<void> {
  for (const target of ORB_RUN_WINNING_ROUTE.slice(0, 2)) walkTo(simulation, target);
}

/** Make `restoreScript` throw on the calls (1-based) `failOn` accepts; returns how many calls it saw. */
function failRestoreScript(
  simulation: HeadlessSceneSimulation,
  failOn: (call: number) => boolean,
): { calls: () => number } {
  let calls = 0;
  const original = simulation.restoreScript.bind(simulation);
  simulation.restoreScript = async (entityId, state) => {
    calls += 1;
    if (failOn(calls)) throw new Error(`injected restoreScript failure #${calls}`);
    await original(entityId, state);
  };
  return { calls: () => calls };
}

// ---- #480: history after a quick-load ------------------------------------------------------------------------

test("quick-load drops the log, events and audio cues of the abandoned timeline", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    await playToMidRun(simulation);
    const save = roundTrip(captureOrbRunSave(simulation));
    const eventsAtSave = simulation.events();
    const cuesAtSave = orbRunAudio(simulation).cues();
    assert.ok(eventsAtSave.length > 0, "the first two orbs were picked up");

    for (const target of ORB_RUN_WINNING_ROUTE.slice(2)) walkTo(simulation, target);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    const futureEvents = simulation.events().filter((entry) => entry.step > save.step);
    const futureCues = orbRunAudio(simulation).cues().filter((cue) => cue.step > save.step);
    assert.ok(futureEvents.length > 0 && futureCues.length > 0, "the abandoned timeline has events and cues of its own");

    await restoreOrbRunSave(simulation, save);

    assert.deepEqual(simulation.events(), eventsAtSave, "events are exactly the ones up to the save");
    assert.equal(simulation.events(ORB_RUN_EVENT.won).length, 0, "the abandoned win is gone");
    assert.deepEqual(orbRunAudio(simulation).cues(), cuesAtSave, "audio cues are exactly the ones up to the save");
    assert.equal(orbRunAudio(simulation).state().activePlaybacks.length, cuesAtSave.length);
    assert.ok(simulation.events().every((entry) => entry.step <= simulation.step));
    assert.ok(simulation.logs().every((entry) => entry.step <= simulation.step));
    assertNonDecreasing(simulation.logs().map((entry) => entry.step), "logs");
    assertNonDecreasing(simulation.events().map((entry) => entry.step), "events");

    // The cut is visible, not silent.
    const rewound = simulation.logs("simulation.timelineRewound");
    assert.equal(rewound.length, 1);
    assert.equal(rewound[0]!.step, save.step);
    assert.equal(rewound[0]!.data?.toStep, save.step);
    assert.equal(rewound[0]!.data?.droppedEvents, futureEvents.length);
    assert.equal(rewound[0]!.data?.droppedCues, futureCues.length);

    // Playing the same route again rebuilds the very same history.
    for (const target of ORB_RUN_WINNING_ROUTE.slice(2)) walkTo(simulation, target);
    assert.equal(simulation.events(ORB_RUN_EVENT.won).length, 1);
    assert.equal(simulation.events().filter((entry) => entry.step > save.step).length, futureEvents.length);
    assertNonDecreasing(simulation.events().map((entry) => entry.step), "events after replaying");
  } finally {
    await simulation.dispose();
  }
});

test("a quick-load that drops nothing writes no rewind entry, and loading a later save keeps all history", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    await playToMidRun(simulation);
    const save = roundTrip(captureOrbRunSave(simulation));
    const logsBefore = simulation.logs();
    await restoreOrbRunSave(simulation, save); // same step: nothing is in the future
    assert.deepEqual(simulation.logs(), logsBefore);
    assert.equal(simulation.logs("simulation.timelineRewound").length, 0);

    const fresh = await startOrbRunSimulation();
    try {
      await restoreOrbRunSave(fresh, save);
      assert.equal(fresh.logs("simulation.timelineRewound").length, 0);
      assert.equal(fresh.events().length, 0, "a fresh simulation never lived the saved timeline: no history to invent");
    } finally {
      await fresh.dispose();
    }
  } finally {
    await simulation.dispose();
  }
});

test("discardHistoryAfter keeps entries at the cut-off step and refuses a bad step", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    await playToMidRun(simulation);
    const lastEventStep = Math.max(...simulation.events().map((entry) => entry.step));
    const dropped = simulation.discardHistoryAfter(lastEventStep);
    assert.equal(dropped.events, 0, "entries recorded at the cut-off step stay");
    assert.equal(simulation.discardHistoryAfter(lastEventStep - 1).events > 0, true);
    for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => simulation.discardHistoryAfter(bad), RangeError);
  } finally {
    await simulation.dispose();
  }
});

// ---- #482: rollback ---------------------------------------------------------------------------------------------

test("a failed apply is rolled back, the original error is thrown, and history is untouched", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    await playToMidRun(simulation);
    const save = roundTrip(captureOrbRunSave(simulation));
    for (const target of ORB_RUN_WINNING_ROUTE.slice(2)) walkTo(simulation, target);
    const before = captureOrbRunSave(simulation);
    const eventsBefore = simulation.events();
    const logsBefore = simulation.logs();
    const cuesBefore = orbRunAudio(simulation).cues();

    // Fail on the 2nd script restore of the save: positions and one script are already applied by then.
    const injected = failRestoreScript(simulation, (call) => call === 2);
    await assert.rejects(restoreOrbRunSave(simulation, save), /injected restoreScript failure #2/);
    assert.ok(injected.calls() > 2, "the rollback restored the scripts again");

    assert.deepEqual(captureOrbRunSave(simulation), before, "state is exactly what it was before the attempt");
    assert.deepEqual(simulation.events(), eventsBefore);
    assert.deepEqual(simulation.logs(), logsBefore);
    assert.deepEqual(orbRunAudio(simulation).cues(), cuesBefore);
    assert.equal(simulation.step, before.step);
  } finally {
    await simulation.dispose();
  }
});

test("a rollback that fails too is reported, with both causes", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    await playToMidRun(simulation);
    const save = roundTrip(captureOrbRunSave(simulation));
    for (const target of ORB_RUN_WINNING_ROUTE.slice(2)) walkTo(simulation, target);

    failRestoreScript(simulation, () => true); // every script restore fails, the rollback's too
    let thrown: unknown;
    try {
      await restoreOrbRunSave(simulation, save);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof OrbRunRestoreError, "a failed rollback is not swallowed");
    assert.equal(thrown.code, "ORB_RUN_RESTORE_FAILED");
    assert.equal(thrown.rolledBack, false);
    assert.match((thrown.cause as Error).message, /injected restoreScript failure #1/);
    assert.match((thrown.rollbackError as Error).message, /injected restoreScript failure #2/);
    assert.match(thrown.message, /rollback failed too/);
    assert.ok(!(thrown instanceof OrbRunSaveError));
  } finally {
    await simulation.dispose();
  }
});

test("after a rollback the animator starts again from rest at the player's position", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    await playToMidRun(simulation);
    const save = roundTrip(captureOrbRunSave(simulation));
    // Keep running so the animator is in full stride when the load fails.
    walkTo(simulation, { x: -4, z: 4 }, { maxSteps: 12 });
    simulation.setAction("player.moveRight", 1);
    simulation.advance(6);
    assert.ok(orbRunAnimator(simulation).state().smoothedSpeed > 0, "the runner is moving");

    failRestoreScript(simulation, (call) => call === 2);
    await assert.rejects(restoreOrbRunSave(simulation, save), /injected/);

    const pose = orbRunAnimator(simulation).state();
    const player = simulation.getPosition(ORB_RUN_ENTITY.player)!;
    assert.equal(pose.step, simulation.step);
    assert.equal(pose.smoothedSpeed, 0, "no stride is carried over from before the failed load");
    assert.equal(pose.dominant, "idle");
    assert.equal(pose.pelvis[0], player[0], "the pose is under the player where the rollback left them");
    assert.equal(pose.pelvis[2], player[2]);
  } finally {
    await simulation.dispose();
  }
});

// ---- #482: one stowed height, a ceiling on the step ----------------------------------------------------------------

test("collected orbs sit at the one shared stowed height, and a save that disagrees is refused", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    walkTo(simulation, ORB_RUN_WINNING_ROUTE[0]!);
    const save = roundTrip(captureOrbRunSave(simulation));
    const collected = ORB_RUN_ORB_IDS.filter((id) => (save.scripts[id] as { collected?: boolean }).collected);
    assert.ok(collected.length >= 1, "the first orb was collected");
    for (const id of collected) {
      assert.equal(save.positions[id]![1], ORB_RUN_STOWED_Y, "the script stows an orb at ORB_RUN_STOWED_Y");
    }
    await restoreOrbRunSave(simulation, save);

    const moved = structuredClone(save);
    moved.positions[collected[0]!]![1] = ORB_RUN_STOWED_Y + 1;
    await assert.rejects(restoreOrbRunSave(simulation, moved), (error: unknown) => {
      assert.ok(error instanceof OrbRunSaveError);
      assert.ok(error.issues.some((issue) => issue.path === `positions.${collected[0]}`));
      return true;
    });
  } finally {
    await simulation.dispose();
  }
});

test("a save may not claim more than a day of play", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const save = roundTrip(captureOrbRunSave(simulation));
    const maxStep = Math.floor(ORB_RUN_MAX_SAVE_SECONDS / simulation.fixedDeltaSeconds);

    for (const step of [maxStep + 1, 1e300, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(
        restoreOrbRunSave(simulation, { ...save, step }),
        (error: unknown) => error instanceof OrbRunSaveError && error.issues.some((issue) => issue.path === "step"),
        `step ${step}`,
      );
      assert.equal(simulation.step, save.step, "a refused save leaves the clock alone");
    }
    // The ceiling itself is still a legal step: the bound is on the claim, not on valid play.
    assert.doesNotMatch(
      String(await restoreOrbRunSave(simulation, { ...save, step: maxStep }).then(() => "ok", (error: unknown) => error)),
      /older than/,
    );
  } finally {
    await simulation.dispose();
  }
});
