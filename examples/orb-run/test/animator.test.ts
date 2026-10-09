import assert from "node:assert/strict";
import test from "node:test";

import {
  FLAT_GROUND,
  ORB_RUN_ACTION,
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_MAX_ANIMATION_FAILURES,
  ORB_RUN_WINNING_ROUTE,
  OrbRunAnimator,
  OrbRunHeadlessProbe,
  RUNNER_LEG_RIG,
  ORB_RUN_SCENE_ID,
  orbRunAnimator,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  captureOrbRunSave,
  restoreOrbRunSave,
  type GroundHeightFn,
  type OrbRunAnimationState,
} from "../src/index.js";

function weightSum(state: OrbRunAnimationState): number {
  return state.weights.idle + state.weights.walk + state.weights.run;
}

test("at rest the runner is idle with both ankles planted on flat ground", async () => {
  const simulation = await startOrbRunSimulation();
  const pose = orbRunAnimator(simulation).state();
  assert.equal(pose.dominant, "idle");
  assert.deepEqual(pose.weights, { idle: 1, walk: 0, run: 0 });
  assert.equal(pose.transitions, 0);
  assert.deepEqual(pose.visited, ["idle"]);
  assert.equal(pose.pelvisDrop, 0);
  assert.ok(Math.abs(pose.pelvis[1] - RUNNER_LEG_RIG.pelvisHeight) < 1e-12);
  for (const foot of [pose.feet.left, pose.feet.right]) {
    assert.equal(foot.planted, true);
    assert.equal(foot.reachable, true);
    assert.ok(Math.abs(foot.ankleY - RUNNER_LEG_RIG.ankleHeight) < 1e-9);
  }
  assert.equal(pose.legsValid, true);
  assert.equal(pose.failedCount, 0);
  await simulation.dispose();
});

test("holding a move action runs the runner up through walk to run, and releasing settles back on idle", async () => {
  const simulation = await startOrbRunSimulation();
  const animator = orbRunAnimator(simulation);
  const dt = simulation.fixedDeltaSeconds;

  simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
  simulation.advance(1);
  const first = animator.state();
  // One step after standing still: raw speed is the full player speed, the smoothed one is only part of the way.
  assert.ok(Math.abs(first.speed - ORB_RUN_DEFAULT_RULES.playerSpeed) < 1e-9);
  assert.ok(first.smoothedSpeed > 0 && first.smoothedSpeed < first.speed);
  assert.ok(first.smoothedSpeed < 1.5, "still between idle and walk after one step");
  assert.equal(first.dominant, "walk", "smoothed ~1 m/s is closer to walk than to idle");
  assert.equal(first.transitions, 1);

  simulation.advance(Math.round(0.5 / dt));
  const running = animator.state();
  assert.equal(running.dominant, "run");
  assert.ok(running.weights.run > 0.9);
  assert.equal(weightSum(running).toFixed(12), "1.000000000000");

  simulation.releaseAllActions();
  simulation.advance(Math.round(1.5 / dt));
  const resting = animator.state();
  assert.equal(resting.speed, 0);
  assert.equal(resting.dominant, "idle");
  assert.equal(resting.smoothedSpeed, 0, "snapped to rest");
  assert.deepEqual(resting.weights, { idle: 1, walk: 0, run: 0 });
  assert.deepEqual(resting.visited, ["idle", "walk", "run"]);
  assert.equal(resting.transitions, 4, "idle→walk→run→walk→idle");
  await simulation.dispose();
});

test("weights always sum to 1 and feet stay planted during a full winning run on flat ground", async () => {
  const simulation = await startOrbRunSimulation();
  const animator = orbRunAnimator(simulation);
  let steps = 0;
  const unsubscribe = simulation.onStep(() => {
    const pose = animator.state();
    steps += 1;
    assert.equal(pose.step, simulation.step);
    assert.ok(Math.abs(weightSum(pose) - 1) < 1e-9, `weights at step ${pose.step}`);
    assert.equal(pose.feet.left.planted && pose.feet.right.planted, true, `planted at step ${pose.step}`);
    assert.equal(pose.legsValid, true);
  });
  for (const target of ORB_RUN_WINNING_ROUTE) walkTo(simulation, target);
  simulation.advance(30);
  unsubscribe();
  assert.equal(summarizeOrbRun(simulation).status, "won");
  assert.ok(steps > 100);
  const pose = animator.state();
  assert.equal(pose.dominant, "idle", "a finished run freezes the player, so the runner stands");
  assert.ok(pose.visited.includes("run"));
  assert.equal(pose.failedCount, 0);
  await simulation.dispose();
});

test("the pose follows the player in x/z and is identical across two runs (determinism)", async () => {
  const observe = async () => {
    const simulation = await startOrbRunSimulation();
    const poses: OrbRunAnimationState[] = [];
    simulation.onStep(() => poses.push(orbRunAnimator(simulation).state()));
    walkTo(simulation, { x: 4, z: -4 });
    walkTo(simulation, { x: 0, z: 0 });
    const player = simulation.getPosition(ORB_RUN_ENTITY.player)!;
    const last = poses[poses.length - 1]!;
    assert.equal(last.pelvis[0], player[0]);
    assert.equal(last.pelvis[2], player[2]);
    await simulation.dispose();
    return poses;
  };
  assert.deepEqual(await observe(), await observe());
});

test("terrain: a step up plants the higher foot higher, a drop lowers the pelvis by exactly the drop", async () => {
  const stepUp: GroundHeightFn = (x) => (x >= 2 ? 0.2 : 0);
  const simulation = await startOrbRunSimulation(undefined, { ground: stepUp });
  const animator = orbRunAnimator(simulation);
  simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
  // Walk until the left foot (x - 0.12) is still on the low ground but the right one (x + 0.12) is on the step.
  assert.equal(simulation.advanceUntil(() => animator.state().feet.right.groundY === 0.2, 600), true);
  const straddling = animator.state();
  assert.equal(straddling.feet.left.groundY, 0);
  assert.ok(Math.abs(straddling.feet.right.ankleY - (0.2 + RUNNER_LEG_RIG.ankleHeight)) < 1e-9);
  assert.ok(Math.abs(straddling.feet.left.ankleY - RUNNER_LEG_RIG.ankleHeight) < 1e-9);
  assert.equal(straddling.pelvisDrop, 0, "stepping up never lowers the pelvis");
  assert.equal(straddling.legsValid, true);
  await simulation.dispose();

  const drop: GroundHeightFn = (x) => (x >= 2 ? -0.3 : 0);
  const dropSim = await startOrbRunSimulation(undefined, { ground: drop });
  const dropAnimator = orbRunAnimator(dropSim);
  dropSim.setAction(ORB_RUN_ACTION.moveRight, 1);
  assert.equal(dropSim.advanceUntil(() => dropAnimator.state().feet.right.groundY === -0.3, 600), true);
  const edge = dropAnimator.state();
  assert.ok(Math.abs(edge.pelvisDrop - 0.3) < 1e-9);
  assert.ok(Math.abs(edge.pelvis[1] - (RUNNER_LEG_RIG.pelvisHeight - 0.3)) < 1e-9);
  assert.equal(edge.feet.left.planted && edge.feet.right.planted, true);
  assert.equal(edge.legsValid, true);
  await dropSim.dispose();
});

test("a ledge beyond leg reach is reported as unreachable while bone lengths stay exact", async () => {
  const simulation = await startOrbRunSimulation(undefined, { ground: (x) => (x >= 2 ? 2 : 0) });
  const animator = orbRunAnimator(simulation);
  simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
  assert.equal(simulation.advanceUntil(() => animator.state().feet.right.groundY === 2, 600), true);
  const pose = animator.state();
  assert.equal(pose.feet.right.reachable, false);
  assert.equal(pose.feet.right.converged, false);
  assert.equal(pose.feet.right.planted, false);
  assert.ok(pose.feet.right.error > 0.1);
  assert.equal(pose.legsValid, true, "the leg stretches, it never stretches the bones");
  assert.equal(pose.failedCount, 0, "unreachable is a result, not a failure");
  await simulation.dispose();
});

test("animation is visual only: a ground function that throws or returns NaN is counted, and the run is still winnable", async () => {
  for (const ground of [() => Number.NaN, () => { throw new Error("terrain unavailable"); }] as GroundHeightFn[]) {
    const simulation = await startOrbRunSimulation(undefined, { ground });
    const animator = orbRunAnimator(simulation);
    for (const target of ORB_RUN_WINNING_ROUTE) walkTo(simulation, target);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    assert.ok(animator.state().failedCount > 100);
    assert.equal(animator.failures().length, ORB_RUN_MAX_ANIMATION_FAILURES, "the failure list is a bounded ring");
    assert.ok(animator.state().failedCount > animator.failures().length, "failedCount stays the running total");
    // Broken from the very first pose: the state is still plain finite JSON (no NaN -> null).
    assert.deepEqual(JSON.parse(JSON.stringify(animator.state())), animator.state());
    assert.match(animator.failures()[0]!.message, /finite|terrain unavailable/);
    // The locomotion half still works without foot IK.
    assert.ok(animator.state().visited.includes("run"));
    await simulation.dispose();
  }
});

test("an impure ground function that fails only after the first read cannot break the simulation loop", async () => {
  let calls = 0;
  const ground: GroundHeightFn = () => {
    calls += 1;
    // Fine for the first pose (construction reads 3 heights), then every 3rd read throws: it fails mid-pose.
    if (calls > 3 && calls % 3 === 2) throw new Error("flaky terrain");
    return 0;
  };
  const simulation = await startOrbRunSimulation(undefined, { ground });
  const animator = orbRunAnimator(simulation);
  for (const target of ORB_RUN_WINNING_ROUTE) walkTo(simulation, target);
  assert.equal(summarizeOrbRun(simulation).status, "won");
  assert.ok(animator.state().failedCount > 0);
  assert.match(animator.failures()[0]!.message, /flaky terrain/);
  await simulation.dispose();
});

test("a restored save restarts the animation from rest at the saved position", async () => {
  const simulation = await startOrbRunSimulation();
  walkTo(simulation, { x: 4, z: -4 });
  const save = captureOrbRunSave(simulation);
  const savedPlayer = simulation.getPosition(ORB_RUN_ENTITY.player)!;
  await simulation.dispose();

  const fresh = await startOrbRunSimulation();
  fresh.restoreStep(save.step);
  await restoreOrbRunSave(fresh, save);
  const animator = orbRunAnimator(fresh);
  const pose = animator.state();
  assert.equal(pose.step, save.step);
  assert.equal(pose.dominant, "idle");
  assert.equal(pose.transitions, 0);
  assert.equal(pose.pelvis[0], savedPlayer[0]);
  assert.equal(pose.pelvis[2], savedPlayer[2]);
  // The first step after the restore is not read as a teleport.
  fresh.advance(1);
  assert.equal(animator.state().speed, 0);
  assert.equal(animator.state().dominant, "idle");
  await fresh.dispose();
});

test("animator option and lifecycle guards", async () => {
  const simulation = await startOrbRunSimulation();
  assert.throws(() => new OrbRunAnimator(simulation, { smoothingSeconds: -1 }), RangeError);
  assert.throws(() => new OrbRunAnimator(simulation, { smoothingSeconds: Number.NaN }), RangeError);

  const raw = new OrbRunAnimator(simulation, { smoothingSeconds: 0, ground: FLAT_GROUND });
  simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
  simulation.advance(1);
  assert.equal(raw.state().smoothedSpeed, raw.state().speed, "no smoothing follows the raw speed");
  assert.equal(raw.state().dominant, "run");

  raw.dispose();
  const frozen = raw.state();
  simulation.advance(5);
  assert.deepEqual(raw.state(), frozen, "a disposed animator stops observing");
  await simulation.dispose();
});

test("the probe reports the animation and rejects nothing silently: bad terrain shows up as a warning log", async () => {
  const probe = new OrbRunHeadlessProbe({ animation: { ground: () => Number.NaN } });
  await probe.start(ORB_RUN_SCENE_ID, 0);
  await probe.step(2);
  const snapshot = await probe.snapshot();
  const animation = (snapshot.state as { animation: OrbRunAnimationState }).animation;
  // One failure for the pose at start (step 0) plus one per step.
  assert.equal(animation.failedCount, 3);
  const logs = await probe.logs();
  assert.equal(logs.filter((log) => log.message === "animation.failed" && log.level === "warning").length, 3);
  await probe.close();
});
