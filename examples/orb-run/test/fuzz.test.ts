import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_INVARIANTS,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_WINNING_ROUTE,
  OrbRunInvariantMonitor,
  analyzeOrbRunLevel,
  captureOrbRunSave,
  checkOrbRunSaveResume,
  comparableOrbRunState,
  createOrbRunProject,
  createSeededRandom,
  driveOrbRunFuzz,
  playOrbRunReplay,
  runOrbRunFuzz,
  runOrbRunFuzzCampaign,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type OrbRunFuzzViolation,
} from "../src/index.js";

function rebalanced(patch: Record<string, number>): ReturnType<typeof createOrbRunProject> {
  const bus = new CommandBus(createOrbRunProject());
  const result = bus.execute({
    requestId: "rebalance",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch },
  });
  assert.equal(result.ok, true);
  return bus.snapshot().project;
}

function describeViolations(violations: readonly OrbRunFuzzViolation[]): string {
  return violations.map((violation) => `step ${violation.step} ${violation.invariant}: ${violation.message}`).join("\n");
}

test("the seeded generator is deterministic, uniform enough, and refuses a non-finite seed", () => {
  const a = createSeededRandom(7);
  const b = createSeededRandom(7);
  const first = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(first, Array.from({ length: 1000 }, () => b()));
  assert.ok(first.every((value) => value >= 0 && value < 1));
  const mean = first.reduce((total, value) => total + value, 0) / first.length;
  assert.ok(mean > 0.45 && mean < 0.55, `mean ${mean}`);
  assert.notDeepEqual(first.slice(0, 5), Array.from({ length: 5 }, createSeededRandom(8)));
  assert.throws(() => createSeededRandom(Number.NaN), RangeError);
  assert.throws(() => createSeededRandom(Infinity), RangeError);
});

test("a fuzz run is a pure function of its seed: same recording, same digest, different seeds differ", async () => {
  const one = await runOrbRunFuzz({ seed: 11, steps: 400 });
  const two = await runOrbRunFuzz({ seed: 11, steps: 400 });
  assert.equal(JSON.stringify(one.replay), JSON.stringify(two.replay));
  assert.equal(one.finalDigest, two.finalDigest);
  const other = await runOrbRunFuzz({ seed: 12, steps: 400 });
  assert.notEqual(other.finalDigest, one.finalDigest);
  // The recording is a complete bug report: replaying it reproduces the final digest.
  const replayed = await playOrbRunReplay(JSON.parse(JSON.stringify(one.replay)));
  assert.equal(replayed.verified, true);
  assert.equal(replayed.finalDigest, one.finalDigest);
});

test("driveOrbRunFuzz validates its arguments", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    assert.throws(() => driveOrbRunFuzz(simulation, { seed: 1, steps: 0 }), RangeError);
    assert.throws(() => driveOrbRunFuzz(simulation, { seed: 1, steps: 1.5 }), RangeError);
    assert.throws(() => driveOrbRunFuzz(simulation, { seed: Number.NaN, steps: 5 }), RangeError);
  } finally {
    await simulation.dispose();
  }
});

test("120 seeded runs over three strategies keep every invariant, and the campaign reaches the interesting outcomes", async () => {
  const strategies = ["random", "seek", "mixed"] as const;
  let won = 0;
  let lost = 0;
  let allOrbs = 0;
  let someOrbs = 0;
  for (const strategy of strategies) {
    const campaign = await runOrbRunFuzzCampaign({ firstSeed: 1000, count: 40, steps: 1200, strategy });
    assert.equal(campaign.runs, 40);
    assert.deepEqual(
      campaign.failures.map((failure) => `${failure.strategy}#${failure.seed}\n${describeViolations(failure.violations)}`),
      [],
    );
    won += campaign.outcomes.won;
    lost += campaign.outcomes.lost;
    someOrbs += campaign.collectedSome;
    allOrbs += campaign.collectedAll;
  }
  // A fuzzer that never wins, never loses or never picks anything up would prove nothing.
  assert.ok(won >= 5, `only ${won} winning runs`);
  assert.ok(lost >= 20, `only ${lost} losing runs`);
  assert.ok(someOrbs >= 30, `only ${someOrbs} runs collected an orb`);
  assert.ok(allOrbs >= won, "every win collected every orb");
});

test("rebalanced rules (fast, tiny arena, short clock, huge arena) keep the same invariants", async () => {
  const variants: Array<{ name: string; patch: Record<string, number> }> = [
    { name: "sprinter", patch: { playerSpeed: 40 } },
    { name: "tiny clock", patch: { timeLimitSeconds: 1.5 } },
    { name: "crawler", patch: { playerSpeed: 0.4, timeLimitSeconds: 60 } },
    { name: "huge pickup radius", patch: { pickupRadius: 30, exitRadius: 30 } },
    // Tight but still around the authored layout (everything is within ±4.5 m); a smaller arena would start the
    // player outside it, which `analyzeOrbRunLevel` reports as `player_outside_arena` and the monitor rightly flags.
    { name: "small arena", patch: { arenaHalfExtent: 5 } },
  ];
  for (const variant of variants) {
    const project = rebalanced(variant.patch);
    const campaign = await runOrbRunFuzzCampaign({ firstSeed: 50, count: 8, steps: 900, project });
    assert.deepEqual(
      campaign.failures.map((failure) => `${variant.name} #${failure.seed}\n${describeViolations(failure.violations)}`),
      [],
      variant.name,
    );
  }
});

test("a run that finishes early keeps stepping frozen until the end of the recording", async () => {
  const result = await runOrbRunFuzz({ seed: 3, steps: 1500, project: rebalanced({ timeLimitSeconds: 2 }) });
  assert.equal(result.final.status, "lost");
  assert.equal(result.final.step, 1500);
  assert.ok(result.final.elapsedSeconds < 2.1, "the clock stopped at the limit instead of running on");
  assert.equal(result.ok, true, describeViolations(result.violations));
});

test("the monitor catches a player teleported out of the arena", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    simulation.advance(2);
    assert.equal(monitor.ok, true);
    simulation.restorePosition(ORB_RUN_ENTITY.player, [500, 0, 0]);
    simulation.advance(1);
    assert.ok(monitor.violations.some((v) => v.invariant === "player_in_arena"), describeViolations(monitor.violations));
    assert.equal(monitor.checked, 3);
  } finally {
    await simulation.dispose();
  }
});

test("the monitor catches a moved orb, a non-finite position and a stopped clock", async () => {
  const moved = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(moved);
    moved.restorePosition(ORB_RUN_ENTITY.orbA, [0, 0, 0]);
    moved.advance(1);
    assert.ok(monitor.violations.some((v) => v.invariant === "orbs_stowed_when_collected"));
  } finally {
    await moved.dispose();
  }

  const camera = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(camera);
    camera.advance(1);
    assert.equal(monitor.ok, true);
    camera.restorePosition(ORB_RUN_ENTITY.camera, [0, 9, 9]);
    camera.advance(1);
    assert.ok(monitor.violations.some((v) => v.invariant === "static_entities_still"));
  } finally {
    await camera.dispose();
  }

  const nan = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(nan);
    nan.restorePosition(ORB_RUN_ENTITY.camera, [Number.NaN, 0, 0]);
    nan.advance(1);
    assert.ok(monitor.violations.some((v) => v.invariant === "positions_finite"));
  } finally {
    await nan.dispose();
  }

  const clock = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(clock);
    clock.advance(3);
    const state = { ...(clock.scriptState(ORB_RUN_ENTITY.manager)!.state as Record<string, unknown>) };
    state.elapsedSeconds = 0;
    state.remainingSeconds = 20;
    await clock.restoreScript(ORB_RUN_ENTITY.manager, state);
    clock.advance(1);
    assert.ok(monitor.violations.some((v) => v.invariant === "clock_consistent"), describeViolations(monitor.violations));
  } finally {
    await clock.dispose();
  }
});

test("the monitor catches an orb that is un-collected, and dispose() stops it observing", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    walkTo(simulation, ORB_RUN_WINNING_ROUTE[0]!, { stopWhen: () => summarizeOrbRun(simulation).collectedCount >= 1 });
    walkTo(simulation, ORB_RUN_WINNING_ROUTE[1]!, { stopWhen: () => summarizeOrbRun(simulation).collectedCount >= 2 });
    simulation.releaseAllActions();
    assert.equal(monitor.ok, true, describeViolations(monitor.violations));
    assert.equal(summarizeOrbRun(simulation).collectedCount, 2);

    // Roll the manager back to an earlier (valid) state: one orb forgotten while its pickup event stays in the log.
    const save = captureOrbRunSave(simulation);
    const manager = { ...save.scripts[ORB_RUN_ENTITY.manager]! };
    manager.collectedOrbIds = (manager.collectedOrbIds as string[]).slice(0, 1);
    manager.collectedCount = 1;
    await simulation.restoreScript(ORB_RUN_ENTITY.manager, manager);
    simulation.advance(1);
    const invariants = new Set(monitor.violations.map((violation) => violation.invariant));
    assert.ok(invariants.has("collected_monotonic"), describeViolations(monitor.violations));
    assert.ok(invariants.has("events_consistent"));

    monitor.dispose();
    const before = monitor.checked;
    simulation.advance(5);
    assert.equal(monitor.checked, before, "a disposed monitor sees no more steps");
  } finally {
    await simulation.dispose();
  }
});

test("the violation list is capped and every name the monitor reports is documented", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(simulation, { maxViolations: 3 });
    simulation.restorePosition(ORB_RUN_ENTITY.player, [500, 0, 500]);
    simulation.advance(10);
    assert.equal(monitor.violations.length, 3);
    for (const violation of monitor.violations) {
      assert.ok((ORB_RUN_INVARIANTS as readonly string[]).includes(violation.invariant));
    }
  } finally {
    await simulation.dispose();
  }
  assert.equal(new Set(ORB_RUN_INVARIANTS).size, ORB_RUN_INVARIANTS.length);
});

test("a save at any step resumes into the uninterrupted run's final state, and the check can fail", async () => {
  const result = await runOrbRunFuzz({ seed: 21, steps: 700, strategy: "seek" });
  assert.equal(result.final.status, "won", "the seek bot should win this seed");
  const reference = await startOrbRunSimulation();
  let expected: ReturnType<typeof comparableOrbRunState>;
  try {
    // Re-derive the uninterrupted state from the recording itself.
    const replayed = await playOrbRunReplay(result.replay, {
      onStep: (simulation) => {
        if (simulation.step === result.replay.totalSteps) expected = comparableOrbRunState(simulation);
      },
    });
    assert.equal(replayed.verified, true);
  } finally {
    await reference.dispose();
  }
  const total = result.replay.totalSteps;
  const firstPickup = result.replay.checkpoints.find((checkpoint) => checkpoint.step > 0)!.step;
  for (const saveStep of [1, 2, firstPickup, Math.floor(total / 3), Math.floor(total / 2), total - 2, total - 1]) {
    const resumed = await checkOrbRunSaveResume(result.replay, saveStep, expected!);
    assert.deepEqual(resumed, { saveStep, equal: true, differences: [] }, `save at ${saveStep}`);
  }
  const wrong = structuredClone(expected!);
  wrong.summary.collectedCount -= 1;
  const mismatch = await checkOrbRunSaveResume(result.replay, 10, wrong);
  assert.equal(mismatch.equal, false);
  assert.deepEqual(mismatch.differences, ["summary"]);
  await assert.rejects(checkOrbRunSaveResume(result.replay, 0, expected!), RangeError);
  await assert.rejects(checkOrbRunSaveResume(result.replay, total, expected!), RangeError);
});

test("a level whose player starts outside the arena is flagged by the static check and by the monitor alike", async () => {
  const project = rebalanced({ arenaHalfExtent: 2 });
  const report = analyzeOrbRunLevel(project);
  assert.ok(report.diagnostics.some((entry) => entry.code === "player_outside_arena"), "the static check warns");
  const simulation = await startOrbRunSimulation(project);
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    simulation.advance(3);
    assert.ok(monitor.violations.some((v) => v.invariant === "player_in_arena"), "the runtime monitor sees the same thing");
  } finally {
    await simulation.dispose();
  }
});
