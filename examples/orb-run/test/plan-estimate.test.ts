import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  createOrbRunProject,
  orbRunSlowZoneComponents,
  orbRunWallComponents,
  startOrbRunSimulation,
  summarizeOrbRun,
  type OrbRunSummary,
} from "../src/index.js";
import { followOrbRunRoute, planOrbRunRoute, type OrbRunRoutePlan } from "../src/navigation.js";

/**
 * Slice 45: the edge of the route planner's time claim on levels with walls and mud (the open-ground cousin is slice 38,
 * "under 3 s of slack" was left open by slice 37). `plan.slackSeconds = timeLimit - plan.estimatedSeconds` is only worth
 * something if its sign predicts what the bot following that plan really does. The bot is deterministic, so its real
 * winning time on a generous clock is a measurement, and the same level with the clock set a few steps either side of that
 * measurement must flip from won to lost.
 */

const STEP = 1 / 30;
const GENEROUS_CLOCK = 300;

interface Obstacle {
  walls: Array<{ x: number; z: number; width: number; depth: number }>;
  mud: Array<{ x: number; z: number; radius: number; speedMultiplier: number }>;
}

/** Player (-4,-4), orbs (4,-4) (0,0) (-4,4) and exit (4,4) of the shipped level: a wall must leave 0.9 m round each. */
const KEY_POINTS: Array<[number, number]> = [[-4, -4], [4, -4], [0, 0], [-4, 4], [4, 4]];

/** Hand-placed levels: a wall that splits the arena, mud on the way, both, and a pillar field. */
const LEVELS: Array<{ name: string; obstacles: Obstacle }> = [
  { name: "split wall", obstacles: { walls: [{ x: -2, z: -2, width: 0.6, depth: 5 }], mud: [] } },
  { name: "mud lake", obstacles: { walls: [], mud: [{ x: 0, z: 0, radius: 2.2, speedMultiplier: 0.4 }] } },
  {
    name: "wall and mud",
    obstacles: { walls: [{ x: -1, z: 1.5, width: 4, depth: 0.5 }], mud: [{ x: 2, z: -1, radius: 1.5, speedMultiplier: 0.5 }] },
  },
  {
    name: "pillars",
    obstacles: {
      walls: [
        { x: -2, z: -1.5, width: 1, depth: 1 },
        { x: 1.5, z: 1, width: 1, depth: 1 },
        { x: 2, z: -2.5, width: 1, depth: 1 },
      ],
      mud: [],
    },
  },
];

function buildLevel(obstacles: Obstacle, timeLimitSeconds: number): ProjectDocument {
  for (const wall of obstacles.walls) {
    for (const [x, z] of KEY_POINTS) {
      const near = Math.abs(x - wall.x) <= wall.width / 2 + 0.9 && Math.abs(z - wall.z) <= wall.depth / 2 + 0.9;
      assert.equal(near, false, `a wall at ${wall.x},${wall.z} buries the key point ${x},${z}`);
    }
  }
  const bus = new CommandBus(createOrbRunProject());
  const run = (requestId: string, command: "entity.create" | "component.patch", payload: unknown) => {
    const result = bus.execute({
      requestId,
      command,
      ...(command === "entity.create" ? { expectedProjectRevision: bus.revision } : {}),
      payload: payload as never,
    });
    assert.equal(result.ok, true, `${requestId} failed: ${JSON.stringify(result)}`);
  };
  obstacles.walls.forEach((wall, index) => {
    run(`wall-${index}`, "entity.create", {
      sceneId: ORB_RUN_SCENE_ID,
      entity: { id: `wall-${index}`, name: `Wall ${index}`, components: orbRunWallComponents({ x: wall.x, z: wall.z }, { width: wall.width, depth: wall.depth }) as ComponentMap },
    });
  });
  obstacles.mud.forEach((patch, index) => {
    run(`mud-${index}`, "entity.create", {
      sceneId: ORB_RUN_SCENE_ID,
      entity: { id: `mud-${index}`, name: `Mud ${index}`, components: orbRunSlowZoneComponents({ x: patch.x, z: patch.z }, patch) as ComponentMap },
    });
  });
  run("clock", "component.patch", { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { timeLimitSeconds } });
  return bus.snapshot().project;
}

/** Follow the plan (planned on the same level), then let a stalled run use up its clock. */
async function playPlan(project: ProjectDocument, plan: OrbRunRoutePlan, clock: number): Promise<OrbRunSummary> {
  const simulation = await startOrbRunSimulation(project);
  try {
    const finished = () => summarizeOrbRun(simulation).status !== "playing";
    followOrbRunRoute(simulation, plan, { stopWhen: finished, maxSteps: Math.ceil(GENEROUS_CLOCK / STEP) });
    const budget = Math.ceil(clock / simulation.fixedDeltaSeconds) + 2;
    for (let used = 0; used < budget && !finished(); used += 1) simulation.advance(1);
    return summarizeOrbRun(simulation);
  } finally {
    await simulation.dispose();
  }
}

test("the planner's slack tracks the bot on walled and muddy levels: a clock a few steps short loses, one a few steps long wins", async () => {
  for (const level of LEVELS) {
    const generous = buildLevel(level.obstacles, GENEROUS_CLOCK);
    const plan = await planOrbRunRoute(generous);
    assert.equal(plan.ok, true, `${level.name}: ${JSON.stringify(plan.diagnostics)}`);
    assert.equal(plan.wallCount, level.obstacles.walls.length, level.name);
    assert.equal(plan.slowZoneCount, level.obstacles.mud.length, level.name);

    const measured = await playPlan(generous, plan, GENEROUS_CLOCK);
    assert.equal(measured.status, "won", `${level.name}: ${JSON.stringify(measured)}`);
    assert.equal(measured.collectedCount, measured.totalOrbs, level.name);
    const real = measured.elapsedSeconds;
    const estimate = plan.estimatedSeconds!;

    // The plan walks to orb *centres* with a navmesh agent fatter than the player; the bot picks orbs up at their radius,
    // so it is never slower than the estimate by more than the wobble of its eight-direction steering.
    const overrun = real - estimate;
    assert.ok(overrun <= 1, `${level.name}: the bot took ${real}s, ${overrun}s more than the plan's ${estimate}s`);
    // And the estimate is no fantasy: the pickup radii save a bounded part of it (0.5 m orbs and exit, 4 stops, at speed).
    const saving = estimate - real;
    assert.ok(saving <= (4 * (ORB_RUN_DEFAULT_RULES.pickupRadius + 0.15)) / ORB_RUN_DEFAULT_RULES.playerSpeed + 1, `${level.name}: the plan overestimates by ${saving}s (plan ${estimate}s, real ${real}s)`);

    // The sign of the slack against the real run: the clock three steps short of the real time loses, three steps over wins.
    const shortClock = real - 3 * STEP;
    const lost = await playPlan(buildLevel(level.obstacles, shortClock), plan, shortClock);
    assert.equal(lost.status, "lost", `${level.name}: a ${shortClock}s clock should lose, got ${JSON.stringify(lost)}`);
    const longClock = real + 3 * STEP;
    const won = await playPlan(buildLevel(level.obstacles, longClock), plan, longClock);
    assert.equal(won.status, "won", `${level.name}: a ${longClock}s clock should win, got ${JSON.stringify(won)}`);

    // A plan that promises slack wins; one whose estimate is far over the clock cannot be won by this bot either.
    const promised = estimate + 3;
    const rich = await playPlan(buildLevel(level.obstacles, promised), plan, promised);
    assert.equal(rich.status, "won", `${level.name}: ${promised}s on an estimate of ${estimate}s is 3 s of slack`);
    const starved = Math.max(real / 2, STEP * 3);
    const poor = await playPlan(buildLevel(level.obstacles, starved), plan, starved);
    assert.equal(poor.status, "lost", `${level.name}: half the real time cannot win`);
  }
});

test("mud shows up in the real run about as the plan prices it: the same walls with and without mud differ by about mudSeconds", async () => {
  const walls = LEVELS[3]!.obstacles.walls;
  const mud = [{ x: 0, z: 0, radius: 2, speedMultiplier: 0.5 }];
  const dry = buildLevel({ walls, mud: [] }, GENEROUS_CLOCK);
  const wet = buildLevel({ walls, mud }, GENEROUS_CLOCK);
  const dryPlan = await planOrbRunRoute(dry);
  const wetPlan = await planOrbRunRoute(wet);
  assert.equal(dryPlan.ok && wetPlan.ok, true);
  assert.equal(dryPlan.mudSeconds, 0);
  assert.ok(wetPlan.mudSeconds! > 0, "the patch sits on the route, so it costs something");
  const dryRun = await playPlan(dry, dryPlan, GENEROUS_CLOCK);
  const wetRun = await playPlan(wet, wetPlan, GENEROUS_CLOCK);
  assert.equal(dryRun.status, "won");
  assert.equal(wetRun.status, "won");
  const plannedExtra = wetPlan.estimatedSeconds! - dryPlan.estimatedSeconds!;
  const realExtra = wetRun.elapsedSeconds - dryRun.elapsedSeconds;
  assert.ok(realExtra > 0, `mud must slow the real run (${realExtra}s)`);
  assert.ok(Math.abs(realExtra - plannedExtra) <= 1, `plan says +${plannedExtra}s, the run says +${realExtra}s`);
});
