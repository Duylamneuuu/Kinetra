import assert from "node:assert/strict";
import test from "node:test";

import {
  ORB_RUN_ACTION,
  OrbRunReplayError,
  OrbRunReplayRecorder,
  captureOrbRunSave,
  parseOrbRunReplay,
  playOrbRunReplay,
  restoreOrbRunSave,
  startOrbRunSimulation,
} from "../src/index.js";

test("a quick-load during recording drops the abandoned timeline from the replay", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const recorder = new OrbRunReplayRecorder(simulation, { checkpointEvery: 10 });
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(40);
    const save = captureOrbRunSave(simulation);
    simulation.advance(30); // step 70: the timeline that is about to be abandoned
    simulation.releaseAllActions();
    simulation.setAction(ORB_RUN_ACTION.moveForward, 1);
    await restoreOrbRunSave(simulation, save);
    assert.equal(simulation.step, 40);
    simulation.advance(25); // steps 41..65, now holding moveForward

    const replay = recorder.finish();
    assert.equal(replay.totalSteps, 65);
    assert.deepEqual(
      replay.inputs.map((input) => [input.step, Object.keys(input.actions)]),
      [
        [1, [ORB_RUN_ACTION.moveRight]],
        [41, [ORB_RUN_ACTION.moveForward]],
      ],
    );
    assert.deepEqual(
      replay.checkpoints.map((checkpoint) => checkpoint.step),
      [10, 20, 30, 40, 50, 60, 65],
    );
    // The recording is a valid replay and plays back to the very same states.
    const parsed = parseOrbRunReplay(JSON.parse(JSON.stringify(replay)));
    const result = await playOrbRunReplay(parsed);
    assert.equal(result.divergence, undefined);
    assert.equal(result.verified, true);
  } finally {
    await simulation.dispose();
  }
});

test("a quick-load right before finish() leaves a replay that ends at the restored step", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const recorder = new OrbRunReplayRecorder(simulation, { checkpointEvery: 10 });
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(20);
    const save = captureOrbRunSave(simulation);
    simulation.releaseAllActions();
    simulation.setAction(ORB_RUN_ACTION.moveLeft, 1);
    simulation.advance(30); // step 50, inputs: right@1, left@21
    await restoreOrbRunSave(simulation, save);

    const replay = recorder.finish();
    assert.equal(replay.totalSteps, 20);
    assert.deepEqual(replay.inputs.map((input) => input.step), [1]);
    assert.deepEqual(replay.checkpoints.map((checkpoint) => checkpoint.step), [10, 20]);
    assert.equal((await playOrbRunReplay(parseOrbRunReplay(JSON.parse(JSON.stringify(replay))))).verified, true);
  } finally {
    await simulation.dispose();
  }
});

test("a restore that jumps the clock forward cannot be recorded and says so", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const recorder = new OrbRunReplayRecorder(simulation);
    simulation.advance(5);
    simulation.restoreStep(500); // a state this recording never reached
    simulation.advance(1);
    assert.throws(
      () => recorder.finish(),
      (error: unknown) => error instanceof OrbRunReplayError && error.code === "timeline_jump",
    );
  } finally {
    await simulation.dispose();
  }
});

test("a forward jump with no step after it is refused too, and a later rewind to a recorded step clears it", async () => {
  const jumped = await startOrbRunSimulation();
  try {
    const recorder = new OrbRunReplayRecorder(jumped);
    jumped.advance(5);
    jumped.restoreStep(9);
    assert.throws(
      () => recorder.finish(),
      (error: unknown) => error instanceof OrbRunReplayError && error.code === "timeline_jump",
    );
  } finally {
    await jumped.dispose();
  }
  const healed = await startOrbRunSimulation();
  try {
    const recorder = new OrbRunReplayRecorder(healed);
    healed.advance(5);
    healed.restoreStep(500);
    healed.advance(1);
    healed.restoreStep(3);
    healed.advance(2); // steps 4, 5
    const replay = recorder.finish();
    assert.equal(replay.totalSteps, 5);
    assert.deepEqual(replay.checkpoints.map((checkpoint) => checkpoint.step), [5]);
  } finally {
    await healed.dispose();
  }
});
