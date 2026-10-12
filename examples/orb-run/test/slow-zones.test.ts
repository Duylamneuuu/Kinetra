import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_ACTION,
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  ORB_RUN_SLOW_ZONE_COMPONENT,
  ORB_RUN_WINNING_ROUTE,
  OrbRunSlowZoneError,
  analyzeOrbRunLevel,
  createOrbRunProject,
  createOrbRunScriptRegistry,
  insideSlowZone,
  orbRunAnimator,
  orbRunSlowZoneComponents,
  readOrbRunSlowZones,
  runOrbRunFuzzCampaign,
  slowZoneMultiplierAt,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type HeadlessSceneSimulation,
  type OrbRunSlowZone,
} from "../src/index.js";

interface ZoneSpec {
  id: string;
  centre: { x: number; z: number };
  radius: number;
  speedMultiplier: number;
}

/** The shipped level plus mud patches authored through the typed command bus (`entity.create`). */
function withZones(zones: readonly ZoneSpec[], rules: Record<string, number> = {}): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  zones.forEach((zone, index) => {
    const result = bus.execute({
      requestId: `zone-${index}`,
      command: "entity.create",
      expectedProjectRevision: bus.revision,
      payload: {
        sceneId: ORB_RUN_SCENE_ID,
        entity: {
          id: zone.id,
          name: `Mud ${zone.id}`,
          components: orbRunSlowZoneComponents(zone.centre, zone) as ComponentMap,
        },
      },
    });
    assert.equal(result.ok, true);
  });
  if (Object.keys(rules).length > 0) {
    const result = bus.execute({
      requestId: "rules",
      command: "component.patch",
      payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: rules as never },
    });
    assert.equal(result.ok, true);
  }
  return bus.snapshot().project;
}

function entitiesOf(project: ProjectDocument) {
  return project.scenes.find((scene) => scene.id === ORB_RUN_SCENE_ID)!.entities;
}

function zone(entityId: string, x: number, z: number, radius: number, speedMultiplier: number): OrbRunSlowZone {
  return { entityId, x, z, radius, speedMultiplier };
}

const PLAYER_SPEED = ORB_RUN_DEFAULT_RULES.playerSpeed;

/** Mud around the player's start (-4, -4): the first leg of the winning route runs through it. */
const START_MUD: ZoneSpec = { id: "mud-start", centre: { x: -4, z: -4 }, radius: 3, speedMultiplier: 0.4 };

test("the shipped level has no slow zones, so nothing about it changes", async () => {
  assert.deepEqual(readOrbRunSlowZones(entitiesOf(createOrbRunProject())), []);
  assert.deepEqual(analyzeOrbRunLevel(createOrbRunProject()).slowZones, []);
  const simulation = await startOrbRunSimulation();
  try {
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(1);
    const moved = summarizeOrbRun(simulation).player[0] - -4;
    assert.ok(Math.abs(moved - PLAYER_SPEED * simulation.fixedDeltaSeconds) < 1e-12);
  } finally {
    await simulation.dispose();
  }
});

test("slowZoneMultiplierAt: the boundary is inside, the slowest overlapping zone wins, outside is full speed", () => {
  const zones = [zone("a", 0, 0, 2, 0.5), zone("b", 1, 0, 1, 0.25)];
  assert.equal(slowZoneMultiplierAt([], 0, 0), 1);
  assert.equal(slowZoneMultiplierAt(zones, 5, 5), 1);
  assert.equal(slowZoneMultiplierAt(zones, -2, 0), 0.5, "exactly on a's boundary counts as inside");
  assert.equal(slowZoneMultiplierAt(zones, -2.0001, 0), 1);
  assert.equal(slowZoneMultiplierAt(zones, 1, 0), 0.25, "both cover (1, 0): the slower wins");
  assert.equal(slowZoneMultiplierAt(zones, 2, 0), 0.25, "b's boundary");
  assert.equal(slowZoneMultiplierAt(zones, 1.5, 1.5), 1, "outside both (a is 2.12 m away, b is 1.58 m away)");
  assert.equal(insideSlowZone(zones[0]!, 1.2, 1.6), true, "a 3-4-5 triangle: 2 m away is on the boundary");
});

test("readOrbRunSlowZones reports every malformed zone at once and never skips one", () => {
  const good = { Transform: { position: [1, 0, 2] }, [ORB_RUN_SLOW_ZONE_COMPONENT]: { radius: 1.5, speedMultiplier: 0.5 } };
  const zones = readOrbRunSlowZones([
    { id: "z-b", components: good as ComponentMap },
    { id: "plain", components: { Transform: { position: [0, 0, 0] } } },
    { id: "z-a", components: { ...good, [ORB_RUN_SLOW_ZONE_COMPONENT]: { radius: 2, speedMultiplier: 1 } } as ComponentMap },
  ]);
  assert.deepEqual(
    zones.map((entry) => [entry.entityId, entry.x, entry.z, entry.radius, entry.speedMultiplier]),
    [
      ["z-a", 1, 2, 2, 1],
      ["z-b", 1, 2, 1.5, 0.5],
    ],
    "sorted by entity id; a multiplier of exactly 1 is legal",
  );

  const bad = (component: unknown, transform: unknown = good.Transform): { id: string; components: ComponentMap } => ({
    id: `bad-${JSON.stringify(component)}`,
    components: { Transform: transform, [ORB_RUN_SLOW_ZONE_COMPONENT]: component } as ComponentMap,
  });
  const entities = [
    bad({ radius: 0, speedMultiplier: 0.5 }),
    bad({ radius: -1, speedMultiplier: 0.5 }),
    bad({ radius: 1 }),
    bad({ radius: 1, speedMultiplier: 0 }),
    bad({ radius: 1, speedMultiplier: 1.5 }),
    bad({ radius: 1, speedMultiplier: "0.5" }),
    bad(7),
    bad([1, 2]),
    bad({ radius: 1, speedMultiplier: 0.5 }, { position: [0, 0] }),
    bad({ radius: 1, speedMultiplier: 0.5 }, { position: [0, Number.NaN, 0] }),
  ];
  assert.throws(
    () => readOrbRunSlowZones(entities),
    (error: unknown) => {
      assert.ok(error instanceof OrbRunSlowZoneError);
      assert.equal(error.code, "ORB_RUN_SLOW_ZONE_INVALID");
      assert.equal(error.issues.length, entities.length, "one issue per bad zone, none skipped");
      assert.match(error.issues[4]!.message, /speedMultiplier must be a finite number in \(0, 1\]/);
      assert.match(error.issues[8]!.message, /finite Transform\.position/);
      return true;
    },
  );
});

test("a malformed zone stops the game from starting instead of silently running without the mud", () => {
  const project = withZones([START_MUD]);
  const bus = new CommandBus(project);
  const result = bus.execute({
    requestId: "break-zone",
    command: "component.patch",
    payload: { entityId: START_MUD.id, component: ORB_RUN_SLOW_ZONE_COMPONENT, patch: { speedMultiplier: 3 } as never },
  });
  assert.equal(result.ok, true, "the command bus stores custom component data as authored");
  assert.throws(() => createOrbRunScriptRegistry(bus.snapshot().project, ORB_RUN_SCENE_ID), OrbRunSlowZoneError);
});

test("inside the mud every step is exactly playerSpeed x multiplier x dt, decided by where the step starts", async () => {
  const simulation = await startOrbRunSimulation(withZones([START_MUD]));
  try {
    const dt = simulation.fixedDeltaSeconds;
    const zones = readOrbRunSlowZones(entitiesOf(withZones([START_MUD])));
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    let insideSteps = 0;
    let outsideSteps = 0;
    for (let index = 0; index < 90; index += 1) {
      const before = summarizeOrbRun(simulation).player;
      simulation.advance(1);
      const after = summarizeOrbRun(simulation).player;
      const expectedMultiplier = slowZoneMultiplierAt(zones, before[0], before[2]);
      if (expectedMultiplier < 1) insideSteps += 1;
      else outsideSteps += 1;
      assert.ok(
        Math.abs(after[0] - before[0] - PLAYER_SPEED * expectedMultiplier * dt) < 1e-9,
        `step ${index}: moved ${after[0] - before[0]} from x=${before[0]}`,
      );
      assert.equal(after[2], before[2]);
    }
    // 3 m of mud at 1.6 m/s is ~57 steps; the rest of the 90 steps are at full speed (and short of the arena edge).
    assert.ok(insideSteps >= 55 && insideSteps <= 58, `${insideSteps} steps in the mud`);
    assert.equal(insideSteps + outsideSteps, 90);
  } finally {
    await simulation.dispose();
  }
});

test("the runner's animation follows the real speed: walking through the mud, running outside it", async () => {
  const simulation = await startOrbRunSimulation(withZones([START_MUD]));
  try {
    const animator = orbRunAnimator(simulation);
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(30); // ~1.6 m into the mud: the smoothed speed has settled
    const muddy = animator.state();
    assert.ok(Math.abs(muddy.speed - PLAYER_SPEED * START_MUD.speedMultiplier) < 1e-9);
    assert.equal(muddy.dominant, "walk");
    assert.ok(muddy.weights.run < 0.05, `run weight ${muddy.weights.run} in the mud`);

    simulation.advance(60); // out of the mud (after ~57 steps) and past the smoothing time, short of the arena edge
    const clear = animator.state();
    assert.ok(Math.abs(clear.speed - PLAYER_SPEED) < 1e-9);
    assert.equal(clear.dominant, "run");
    assert.deepEqual(clear.visited, ["idle", "walk", "run"]);
    assert.equal(clear.failedCount, 0);
    assert.equal(clear.legsValid, true);
  } finally {
    await simulation.dispose();
  }
});

function playRoute(simulation: HeadlessSceneSimulation): void {
  const finished = () => summarizeOrbRun(simulation).status !== "playing";
  for (const target of ORB_RUN_WINNING_ROUTE) {
    walkTo(simulation, target, { stopWhen: finished, playerSpeed: PLAYER_SPEED });
    if (finished()) return;
  }
  simulation.advance(1);
}

test("mud costs clock time: the same route wins on open ground and loses on a clock the mud makes too short", async () => {
  const open = await startOrbRunSimulation();
  let openElapsed: number;
  try {
    playRoute(open);
    const summary = summarizeOrbRun(open);
    assert.equal(summary.status, "won");
    openElapsed = summary.elapsedSeconds;
  } finally {
    await open.dispose();
  }

  // A 1 m-radius patch on the route: the bot's axis-by-axis legs cross it four times (about 4 m of mud, 0.25 s per metre).
  const mud: ZoneSpec = { id: "mud-leg", centre: { x: 0, z: -4 }, radius: 1, speedMultiplier: 0.5 };
  const muddy = await startOrbRunSimulation(withZones([mud]));
  try {
    playRoute(muddy);
    const summary = summarizeOrbRun(muddy);
    assert.equal(summary.status, "won", "20 s is plenty");
    const extra = summary.elapsedSeconds - openElapsed;
    assert.ok(extra > 0.8 && extra < 1.2, `the mud cost ${extra} s`);
  } finally {
    await muddy.dispose();
  }

  const tightClock = openElapsed + 0.25;
  const fine = await startOrbRunSimulation(withZones([], { timeLimitSeconds: tightClock }));
  try {
    playRoute(fine);
    assert.equal(summarizeOrbRun(fine).status, "won", "without mud the tight clock is still enough");
  } finally {
    await fine.dispose();
  }
  const slow = await startOrbRunSimulation(withZones([mud], { timeLimitSeconds: tightClock }));
  try {
    playRoute(slow);
    assert.equal(summarizeOrbRun(slow).status, "lost", "with the mud the same clock runs out");
  } finally {
    await slow.dispose();
  }
});

test("level check: slow zones keep the lower bound, withdraw the playtest claim and say so", () => {
  const open = analyzeOrbRunLevel(createOrbRunProject());
  assert.equal(open.verdict, "comfortable");

  const report = analyzeOrbRunLevel(withZones([START_MUD]));
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "unproven");
  assert.equal(report.lowerBoundSeconds, open.lowerBoundSeconds, "mud only slows, so nothing beats the open-ground bound");
  assert.equal(report.playtestSeconds, null);
  assert.equal(report.slackSeconds, null);
  assert.equal(report.route, null);
  assert.deepEqual(
    report.slowZones.map((entry) => [entry.entityId, entry.radius, entry.speedMultiplier]),
    [["mud-start", 3, 0.4]],
  );
  assert.deepEqual(
    report.diagnostics.map((entry) => entry.code),
    ["slow_zones_present"],
  );
  assert.match(report.diagnostics[0]!.message, /1 slow zone/);

  // A clock below the open-ground lower bound is still provably impossible.
  const impossible = analyzeOrbRunLevel(withZones([START_MUD], { timeLimitSeconds: 1 }));
  assert.equal(impossible.verdict, "impossible");
  assert.ok(impossible.diagnostics.some((entry) => entry.code === "time_impossible"));
});

test("level check: a malformed zone is an error diagnostic with the entity id, not an exception", () => {
  const bus = new CommandBus(withZones([START_MUD]));
  bus.execute({
    requestId: "zero-multiplier",
    command: "component.patch",
    payload: { entityId: START_MUD.id, component: ORB_RUN_SLOW_ZONE_COMPONENT, patch: { speedMultiplier: 0 } as never },
  });
  const report = analyzeOrbRunLevel(bus.snapshot().project);
  assert.equal(report.ok, false);
  assert.equal(report.verdict, "invalid");
  const issue = report.diagnostics.find((entry) => entry.code === "slow_zone_invalid");
  assert.ok(issue);
  assert.equal(issue.entityId, START_MUD.id);
  assert.equal(issue.severity, "error");
});

test("fuzzing on a muddy level keeps every invariant and never exceeds the speed of the zone it starts in", async () => {
  const mud: ZoneSpec[] = [
    START_MUD,
    { id: "mud-centre", centre: { x: 0, z: 0 }, radius: 1.5, speedMultiplier: 0.25 },
    { id: "mud-edge", centre: { x: 3.5, z: 3.5 }, radius: 2, speedMultiplier: 0.6 },
  ];
  const project = withZones(mud);
  const zones = readOrbRunSlowZones(entitiesOf(project));
  for (const strategy of ["random", "seek", "mixed"] as const) {
    const campaign = await runOrbRunFuzzCampaign({ firstSeed: 500, count: 4, steps: 900, strategy, project });
    assert.deepEqual(
      campaign.failures.map((failure) => `${strategy}#${failure.seed}`),
      [],
      strategy,
    );
  }

  // The speed ceiling per step, seen from outside: displacement never beats the multiplier under the step's start.
  const simulation = await startOrbRunSimulation(project);
  try {
    const dt = simulation.fixedDeltaSeconds;
    let previous = summarizeOrbRun(simulation).player;
    let slowedSteps = 0;
    simulation.onStep(() => {
      const current = summarizeOrbRun(simulation).player;
      const multiplier = slowZoneMultiplierAt(zones, previous[0], previous[2]);
      if (multiplier < 1) slowedSteps += 1;
      const moved = Math.hypot(current[0] - previous[0], current[2] - previous[2]);
      assert.ok(moved <= PLAYER_SPEED * multiplier * dt + 1e-9, `moved ${moved} m with multiplier ${multiplier}`);
      previous = current;
    });
    for (let index = 0; index < 600; index += 1) {
      simulation.setAction(ORB_RUN_ACTION.moveRight, index % 90 < 60 ? 1 : 0);
      simulation.setAction(ORB_RUN_ACTION.moveBackward, index % 120 < 70 ? 1 : 0);
      simulation.advance(1);
    }
    assert.ok(slowedSteps > 50, `only ${slowedSteps} steps in the mud`);
  } finally {
    await simulation.dispose();
  }
});

test("a run through the mud is deterministic", async () => {
  const project = withZones([START_MUD]);
  const run = async (): Promise<ReturnType<typeof summarizeOrbRun>> => {
    const simulation = await startOrbRunSimulation(project);
    try {
      playRoute(simulation);
      return summarizeOrbRun(simulation);
    } finally {
      await simulation.dispose();
    }
  };
  const first = await run();
  assert.deepEqual(await run(), first);
  assert.equal(first.status, "won");
});
