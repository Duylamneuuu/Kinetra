import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import { AcceptanceRunner } from "@kinetra/verification";

import {
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_LEVELS,
  ORB_RUN_LEVEL_IDS,
  ORB_RUN_SCENE_ID,
  analyzeOrbRunLevel,
  authorOrbRunLevelWithCommandBus,
  createOrbRunLevelProject,
  createOrbRunProject,
  createOrbRunReplayManifest,
  getOrbRunLevel,
  orbRunAuthoringPlan,
  orbRunLevelMudId,
  orbRunLevelPlan,
  orbRunLevelWallId,
  playOrbRunReplay,
  readOrbRunWalls,
  readOrbRunSlowZones,
  recordOrbRunReplay,
  runOrbRunFuzzCampaign,
  startOrbRunSimulation,
  summarizeOrbRun,
  toEngineCommand,
  type OrbRunLevelDefinition,
} from "../src/index.js";
import { createOrbRunNavigationProbe, followOrbRunRoute, planOrbRunRoute } from "../src/navigation.js";

/**
 * Slice 47: the level pack (`src/levels.ts`). A level is the shipped courtyard plus walls, mud and a clock, authored
 * through the same command bus. The tooling that was built one piece at a time (level check, planner, fuzzer, replays,
 * acceptance manifests) is run on every level, so a level that is added later is held to the same bar by this file.
 */

/** Player start, the three orbs and the exit of the courtyard: an obstacle must leave this much clear round each. */
const KEY_POINTS: Array<[number, number]> = [[-4, -4], [4, -4], [0, 0], [-4, 4], [4, 4]];
const CLEARANCE = 0.9;
const MIN_PROMISED_SLACK_SECONDS = 3;

function scene(project: ReturnType<typeof createOrbRunProject>) {
  return project.scenes.find((candidate) => candidate.id === ORB_RUN_SCENE_ID)!;
}

test("the pack has unique ids, a classic level, and every level is found by its id", () => {
  assert.equal(new Set(ORB_RUN_LEVEL_IDS).size, ORB_RUN_LEVELS.length);
  assert.ok(ORB_RUN_LEVELS.length >= 4);
  assert.equal(ORB_RUN_LEVELS[0]?.id, "classic");
  for (const level of ORB_RUN_LEVELS) {
    assert.match(level.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(getOrbRunLevel(level.id), level);
    assert.ok(level.title.length > 0 && level.summary.length > 0);
  }
  assert.throws(() => getOrbRunLevel("nope"), (error) => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /Unknown Orb Run level "nope"/);
    for (const id of ORB_RUN_LEVEL_IDS) assert.ok(error.message.includes(id), `the message lists ${id}`);
    return true;
  });
  // Inherited property names are not levels.
  for (const bad of ["constructor", "__proto__", "toString", ""]) assert.throws(() => getOrbRunLevel(bad), RangeError, bad);
});

test("classic is the shipped level byte for byte; the others only add obstacles and a clock after it", () => {
  assert.deepEqual(orbRunLevelPlan("classic"), orbRunAuthoringPlan());
  assert.deepEqual(createOrbRunLevelProject("classic"), createOrbRunProject());
  const base = orbRunAuthoringPlan();
  for (const level of ORB_RUN_LEVELS) {
    const plan = orbRunLevelPlan(level.id);
    assert.deepEqual(plan.slice(0, base.length), base, `${level.id} starts with the shipped plan`);
    const extra = plan.slice(base.length);
    const clock = level.timeLimitSeconds !== undefined && level.timeLimitSeconds !== ORB_RUN_DEFAULT_RULES.timeLimitSeconds ? 1 : 0;
    assert.equal(extra.length, level.walls.length + level.mud.length + clock, level.id);
    assert.deepEqual(
      extra.map((step) => step.tool),
      [...level.walls, ...level.mud].map(() => "entity.create").concat(clock ? ["entity.patch"] : []),
      level.id,
    );
  }
});

test("every level authors cleanly through the command bus, one revision per step, and twice gives the same bytes", () => {
  for (const level of ORB_RUN_LEVELS) {
    const bus = authorOrbRunLevelWithCommandBus(level.id);
    assert.equal(bus.revision, orbRunLevelPlan(level.id).length, `${level.id}: one revision per step`);
    const first = JSON.stringify(bus.snapshot().project);
    assert.equal(JSON.stringify(createOrbRunLevelProject(level.id)), first, level.id);
    // The obstacles are entities of the scene with the documented stable ids.
    const ids = new Set(scene(bus.snapshot().project).entities.map((entity) => entity.id));
    level.walls.forEach((_, index) => assert.ok(ids.has(orbRunLevelWallId(level.id, index)), `${level.id} wall ${index}`));
    level.mud.forEach((_, index) => assert.ok(ids.has(orbRunLevelMudId(level.id, index)), `${level.id} mud ${index}`));
    // A different level is a different project.
    for (const other of ORB_RUN_LEVELS) {
      if (other.id !== level.id) assert.notEqual(JSON.stringify(createOrbRunLevelProject(other.id)), first, `${level.id} vs ${other.id}`);
    }
  }
});

test("a stale plan fails loudly: a level plan replayed on a project that already has it, or on a stale revision, is refused and changes nothing", () => {
  const level = ORB_RUN_LEVELS.find((candidate) => candidate.walls.length > 0)!;
  const bus = new CommandBus(createOrbRunLevelProject(level.id));
  const first = orbRunLevelPlan(level.id)[0]!;
  const before = JSON.stringify(bus.snapshot().project);
  assert.throws(
    () => bus.execute({ ...toEngineCommand(first, 0), expectedProjectRevision: bus.revision }),
    (error) => (error as { code?: string }).code === "SCENE_ALREADY_EXISTS",
  );
  assert.equal(JSON.stringify(bus.snapshot().project), before, "the refused command changed nothing");
  // And a stale revision on a fresh step is refused too, with the project untouched.
  assert.throws(
    () => bus.execute({ ...toEngineCommand(orbRunLevelPlan(level.id).at(-1)!, 1), expectedProjectRevision: bus.revision - 1 }),
    (error) => (error as { code?: string }).code === "STALE_REVISION",
  );
  assert.equal(JSON.stringify(bus.snapshot().project), before);
});

test("no obstacle buries the start, an orb or the exit (0.9 m clear round each key point)", () => {
  for (const level of ORB_RUN_LEVELS) {
    for (const wall of level.walls) {
      for (const [x, z] of KEY_POINTS) {
        const near = Math.abs(x - wall.x) <= wall.width / 2 + CLEARANCE && Math.abs(z - wall.z) <= wall.depth / 2 + CLEARANCE;
        assert.equal(near, false, `${level.id}: wall at ${wall.x},${wall.z} is within ${CLEARANCE} m of ${x},${z}`);
      }
    }
    // Mud may cover an orb (the swamp does), but never the player's start: a run must not begin already slowed.
    for (const patch of level.mud) {
      assert.ok(Math.hypot(patch.x - -4, patch.z - -4) > patch.radius, `${level.id}: mud covers the start`);
      assert.ok(patch.speedMultiplier > 0 && patch.speedMultiplier <= 1, level.id);
    }
  }
});

test("the static level check passes on every level and reads exactly the obstacles the definition lists", () => {
  for (const level of ORB_RUN_LEVELS) {
    const project = createOrbRunLevelProject(level.id);
    const report = analyzeOrbRunLevel(project);
    assert.equal(report.ok, true, `${level.id}: ${JSON.stringify(report.diagnostics)}`);
    assert.equal(report.errorCount, 0, level.id);
    assert.equal(report.orbCount, 3, level.id);
    const walls = readOrbRunWalls(scene(project).entities);
    assert.equal(walls.length, level.walls.length, level.id);
    assert.equal(readOrbRunSlowZones(scene(project).entities).length, level.mud.length, level.id);
    for (const wall of level.walls) {
      assert.ok(walls.some((read) => read.x === wall.x && read.z === wall.z && read.halfWidth === wall.width / 2 && read.halfDepth === wall.depth / 2), `${level.id} wall ${wall.x},${wall.z}`);
    }
    assert.equal(report.rules?.timeLimitSeconds, level.timeLimitSeconds ?? ORB_RUN_DEFAULT_RULES.timeLimitSeconds, level.id);
    // Only an empty courtyard gets a time claim from the static check; obstacles withdraw it (the planner prices them).
    if (level.walls.length === 0 && level.mud.length === 0) assert.equal(report.verdict, "comfortable", level.id);
    else assert.equal(report.verdict, "unproven", level.id);
  }
});

/** Plays the planned route on a level and returns the finished run. */
async function playLevel(level: OrbRunLevelDefinition) {
  const project = createOrbRunLevelProject(level.id);
  const plan = await planOrbRunRoute(project);
  assert.equal(plan.ok, true, `${level.id}: ${JSON.stringify(plan.diagnostics)}`);
  const simulation = await startOrbRunSimulation(project);
  try {
    const finished = () => summarizeOrbRun(simulation).status !== "playing";
    followOrbRunRoute(simulation, plan, { stopWhen: finished, maxSteps: 900 });
    return { plan, summary: summarizeOrbRun(simulation) };
  } finally {
    await simulation.dispose();
  }
}

test("every level is winnable on its own clock by the planned route, with the slack the planner promised", async () => {
  for (const level of ORB_RUN_LEVELS) {
    const { plan, summary } = await playLevel(level);
    assert.equal(plan.wallCount, level.walls.length, level.id);
    assert.equal(plan.slowZoneCount, level.mud.length, level.id);
    assert.ok(plan.slackSeconds! >= MIN_PROMISED_SLACK_SECONDS, `${level.id}: only ${plan.slackSeconds} s of slack on a ${level.timeLimitSeconds ?? 20} s clock`);
    assert.equal(summary.status, "won", `${level.id}: ${JSON.stringify(summary)}`);
    assert.equal(summary.collectedCount, summary.totalOrbs, level.id);
    assert.ok(summary.elapsedSeconds <= plan.estimatedSeconds! + 1, `${level.id}: took ${summary.elapsedSeconds}s, plan said ${plan.estimatedSeconds}s`);
    // A level's own clock only ever tightens the courtyard's 20 s; it never hands out more time.
    assert.ok((level.timeLimitSeconds ?? 20) <= 20, level.id);
  }
});

test("idling loses on every level, on that level's own clock, with nothing collected", async () => {
  for (const level of ORB_RUN_LEVELS) {
    const simulation = await startOrbRunSimulation(createOrbRunLevelProject(level.id));
    try {
      simulation.advance(Math.ceil(((level.timeLimitSeconds ?? 20) + 1) / simulation.fixedDeltaSeconds));
      const summary = summarizeOrbRun(simulation);
      assert.equal(summary.status, "lost", level.id);
      assert.equal(summary.collectedCount, 0, level.id);
    } finally {
      await simulation.dispose();
    }
  }
});

test("each level holds every fuzz invariant on seeded campaigns of all three strategies", async () => {
  for (const level of ORB_RUN_LEVELS) {
    const project = createOrbRunLevelProject(level.id);
    for (const strategy of ["random", "seek", "mixed"] as const) {
      const campaign = await runOrbRunFuzzCampaign({ firstSeed: 4700, count: 3, steps: 700, strategy, project });
      assert.deepEqual(
        campaign.failures.map((failure) => `${level.id}/${strategy}#${failure.seed}: ${failure.violations.map((v) => `${v.step} ${v.invariant}`).join(", ")}`),
        [],
        `${level.id}/${strategy}`,
      );
    }
  }
});

test("a winning recording per level replays verified on its own level and pins the level through an AcceptanceManifest", async () => {
  for (const level of ORB_RUN_LEVELS) {
    const project = createOrbRunLevelProject(level.id);
    const plan = await planOrbRunRoute(project);
    assert.equal(plan.ok, true, level.id);
    const replay = await recordOrbRunReplay(
      (simulation) => {
        const finished = () => summarizeOrbRun(simulation).status !== "playing";
        followOrbRunRoute(simulation, plan, { stopWhen: finished, maxSteps: 900 });
        simulation.advance(1);
      },
      { project },
    );
    assert.equal(replay.outcome.status, "won", level.id);

    const verified = await playOrbRunReplay(JSON.parse(JSON.stringify(replay)), { project });
    assert.equal(verified.verified, true, level.id);

    // The same recording as an engine manifest: green on this level, red on every other level.
    const manifest = createOrbRunReplayManifest(replay, `orb-run.level.${level.id}`);
    const passing = await new AcceptanceRunner(createOrbRunNavigationProbe({ project })).run(manifest);
    assert.equal(passing.passed, true, `${level.id}: ${JSON.stringify(passing.steps.find((step) => !step.passed))}`);
    for (const other of ORB_RUN_LEVELS) {
      if (other.id === level.id) continue;
      const failing = await new AcceptanceRunner(createOrbRunNavigationProbe({ project: createOrbRunLevelProject(other.id) })).run(manifest);
      assert.equal(failing.passed, false, `a ${level.id} recording must not pass on ${other.id}`);
    }
  }
});

test("a manifest pins what a level is: its obstacles, its price on the planner and its clock", async () => {
  const level = getOrbRunLevel("causeway");
  const project = createOrbRunLevelProject(level.id);
  const plan = await planOrbRunRoute(project);
  const manifest = {
    schemaVersion: 1 as const,
    suite: "orb-run.level.causeway.facts",
    seed: 0,
    target: "runtime" as const,
    steps: [
      { type: "runtime.start" as const, sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.equal" as const, path: "state.level.rules.timeLimitSeconds", expected: 14 },
      { type: "assert.equal" as const, path: "state.level.walls.0.entityId", expected: orbRunLevelWallId(level.id, 0) },
      { type: "assert.equal" as const, path: "state.level.slowZones.0.entityId", expected: orbRunLevelMudId(level.id, 0) },
      { type: "assert.equal" as const, path: "state.navigation.wallCount", expected: 1 },
      { type: "assert.equal" as const, path: "state.navigation.slowZoneCount", expected: 1 },
      { type: "assert.near" as const, path: "state.navigation.estimatedSeconds", expected: plan.estimatedSeconds!, tolerance: 1e-6 },
      { type: "runtime.stop" as const },
    ],
  };
  const passing = await new AcceptanceRunner(createOrbRunNavigationProbe({ project })).run(manifest);
  assert.equal(passing.passed, true, JSON.stringify(passing.steps.find((step) => !step.passed)));
  // On the classic courtyard the very first fact (the clock) is already wrong.
  const failing = await new AcceptanceRunner(createOrbRunNavigationProbe()).run(manifest);
  assert.equal(failing.passed, false);
  assert.equal(failing.steps.find((step) => !step.passed)?.index, 1);
});
