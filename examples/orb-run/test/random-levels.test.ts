import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, JsonValue, ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_ORB_IDS,
  ORB_RUN_SCENE_ID,
  OrbRunInvariantMonitor,
  analyzeOrbRunLevel,
  createOrbRunProject,
  orbRunSlowZoneComponents,
  orbRunWallComponents,
  readOrbRunWalls,
  circleHitsWall,
  startOrbRunSimulation,
  summarizeOrbRun,
} from "../src/index.js";
import { densifyRoute, followOrbRunRoute, planOrbRunRoute } from "../src/navigation.js";

/**
 * Slice 37: the level tooling is held to the game on levels nobody drew by hand. A seeded generator scatters 1-3 walls
 * and 0-2 mud patches on the shipped level through the typed command bus (`entity.create`), keeping every key point
 * (start, orbs, exit) at least 1 m clear of a wall, then checks that the three things that make claims about a level --
 * the static level check, the navmesh route plan and the real simulation -- never contradict each other.
 */

const LEVELS = 60;
const CLEARANCE = 1;

interface Rect {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function positionOf(components: Record<string, JsonValue>): { x: number; z: number } | undefined {
  const transform = components.Transform;
  if (typeof transform !== "object" || transform === null || Array.isArray(transform)) return undefined;
  const position = transform.position;
  if (!Array.isArray(position) || typeof position[0] !== "number" || typeof position[2] !== "number") return undefined;
  return { x: position[0], z: position[2] };
}

/** Player, orbs and exit of the shipped level: the places a generated wall must stay away from. */
function keyPoints(): Array<{ x: number; z: number }> {
  const scene = createOrbRunProject().scenes.find((candidate) => candidate.id === ORB_RUN_SCENE_ID)!;
  const ids = new Set<string>([ORB_RUN_ENTITY.player, ORB_RUN_ENTITY.exit, ...ORB_RUN_ORB_IDS]);
  const points: Array<{ x: number; z: number }> = [];
  for (const entity of scene.entities) {
    const position = positionOf(entity.components);
    if (ids.has(entity.id) && position) points.push(position);
  }
  assert.equal(points.length, 5, "player, 3 orbs and exit");
  return points;
}

function rectNearPoint(rect: Rect, point: { x: number; z: number }, margin: number): boolean {
  return Math.abs(point.x - rect.x) <= rect.width / 2 + margin && Math.abs(point.z - rect.z) <= rect.depth / 2 + margin;
}

function generateWalls(random: () => number, points: Array<{ x: number; z: number }>): Rect[] {
  const limit = ORB_RUN_DEFAULT_RULES.arenaHalfExtent;
  const wanted = 1 + Math.floor(random() * 3);
  const walls: Rect[] = [];
  for (let attempt = 0; attempt < 60 && walls.length < wanted; attempt += 1) {
    const horizontal = random() < 0.5;
    const long = 1.5 + random() * 5;
    const thin = 0.3 + random() * 0.9;
    const rect: Rect = {
      id: `wall-${walls.length}`,
      x: (random() * 2 - 1) * limit,
      z: (random() * 2 - 1) * limit,
      width: horizontal ? long : thin,
      depth: horizontal ? thin : long,
    };
    if (points.some((point) => rectNearPoint(rect, point, CLEARANCE))) continue;
    walls.push(rect);
  }
  return walls;
}

function generateMud(random: () => number): Array<{ id: string; x: number; z: number; radius: number; speedMultiplier: number }> {
  const limit = ORB_RUN_DEFAULT_RULES.arenaHalfExtent;
  const count = Math.floor(random() * 3);
  return Array.from({ length: count }, (_, index) => ({
    id: `mud-${index}`,
    x: (random() * 2 - 1) * limit,
    z: (random() * 2 - 1) * limit,
    radius: 0.8 + random() * 1.7,
    speedMultiplier: 0.3 + random() * 0.6,
  }));
}

function buildLevel(seed: number): { project: ProjectDocument; walls: Rect[]; mud: ReturnType<typeof generateMud> } {
  const random = mulberry32(seed * 7919 + 13);
  const walls = generateWalls(random, keyPoints());
  const mud = generateMud(random);
  const bus = new CommandBus(createOrbRunProject());
  const create = (id: string, name: string, components: ComponentMap) => {
    const result = bus.execute({
      requestId: `create-${id}`,
      command: "entity.create",
      expectedProjectRevision: bus.revision,
      payload: { sceneId: ORB_RUN_SCENE_ID, entity: { id, name, components } },
    });
    assert.equal(result.ok, true, `seed ${seed}: creating ${id} failed`);
  };
  for (const wall of walls) {
    create(wall.id, `Wall ${wall.id}`, orbRunWallComponents({ x: wall.x, z: wall.z }, { width: wall.width, depth: wall.depth }) as ComponentMap);
  }
  for (const patch of mud) {
    create(patch.id, `Mud ${patch.id}`, orbRunSlowZoneComponents({ x: patch.x, z: patch.z }, patch) as ComponentMap);
  }
  return { project: bus.snapshot().project, walls, mud };
}

const KNOWN_PLAN_FAILURES = new Set(["route_blocked", "level_invalid"]);

test("generated levels: level check, route plan and the real game never contradict each other", async () => {
  let planned = 0;
  let blocked = 0;
  let withMud = 0;
  let withWalls = 0;
  for (let seed = 1; seed <= LEVELS; seed += 1) {
    const { project, walls, mud } = buildLevel(seed);
    const label = `seed ${seed} (${walls.length} walls, ${mud.length} mud)`;
    withWalls += walls.length > 0 ? 1 : 0;
    withMud += mud.length > 0 ? 1 : 0;

    const report = analyzeOrbRunLevel(project);
    assert.equal(report.ok, true, `${label}: generated levels keep the key points clear, so the check must pass: ${JSON.stringify(report.diagnostics)}`);
    assert.equal(report.walls.length, walls.length, label);
    // Walls or mud withdraw the straight-line claim: the check never promises a time it cannot prove.
    assert.equal(report.playtestSeconds, null, label);
    assert.equal(report.route, null, label);
    assert.notEqual(report.verdict, "comfortable", `${label}: no comfortable claim on a level with obstacles`);

    const plan = await planOrbRunRoute(project);
    if (!plan.ok) {
      blocked += 1;
      assert.ok(
        plan.diagnostics.length > 0 && plan.diagnostics.every((entry) => KNOWN_PLAN_FAILURES.has(entry.code)),
        `${label}: unexpected plan failure ${JSON.stringify(plan.diagnostics)}`,
      );
      assert.deepEqual(plan.legs, [], label);
      continue;
    }
    planned += 1;
    assert.equal(plan.wallCount, walls.length, label);
    assert.equal(plan.slowZoneCount, mud.length, label);

    // The planned polyline never enters a wall for the gameplay circle (the navmesh agent is fatter).
    const authoredWalls = readOrbRunWalls(project.scenes.find((scene) => scene.id === ORB_RUN_SCENE_ID)!.entities);
    for (const point of densifyRoute(plan.path, 0.1)) {
      assert.equal(circleHitsWall(authoredWalls, point.x, point.z), false, `${label}: route enters a wall at ${point.x},${point.z}`);
    }
    // Mud can only slow the walk down.
    assert.ok(plan.mudSeconds! >= 0, `${label}: mudSeconds ${plan.mudSeconds}`);
    // (the plan rounds its figures to the millimetre / millisecond, hence the tolerance)
    assert.ok(plan.estimatedSeconds! >= plan.lengthMeters! / ORB_RUN_DEFAULT_RULES.playerSpeed - 2e-3, label);

    // Walk it in the real simulation with every invariant watching.
    const simulation = await startOrbRunSimulation(project);
    try {
      const monitor = new OrbRunInvariantMonitor(simulation);
      const done = () => summarizeOrbRun(simulation).status !== "playing";
      followOrbRunRoute(simulation, plan, { stopWhen: done });
      simulation.advance(2);
      assert.deepEqual(monitor.violations, [], `${label}: invariants broke while following the plan`);

      const summary = summarizeOrbRun(simulation);
      if (plan.slackSeconds! >= 3) {
        // A plan with real slack is a promise: the bot following it wins with every orb.
        assert.equal(summary.status, "won", `${label}: plan promised ${plan.slackSeconds}s of slack but the run is ${JSON.stringify(summary)}`);
        assert.equal(summary.collectedCount, summary.totalOrbs, label);
        // And nothing beats the level check's lower bound.
        assert.notEqual(report.lowerBoundSeconds, null, label);
        assert.ok(summary.elapsedSeconds >= report.lowerBoundSeconds! - 1e-9, `${label}: won in ${summary.elapsedSeconds}s under the lower bound ${report.lowerBoundSeconds}s`);
      }
    } finally {
      await simulation.dispose();
    }
  }
  // The campaign is not vacuous: obstacles of both kinds were generated and most plans exist.
  assert.ok(withWalls >= LEVELS - 1, `walls generated on ${withWalls} levels`);
  assert.ok(withMud >= 20, `mud generated on ${withMud} levels`);
  assert.ok(planned >= 30, `only ${planned} of ${LEVELS} levels produced a plan (${blocked} blocked)`);
});

test("the generator is deterministic and keeps every key point clear of its walls", () => {
  const points = keyPoints();
  for (let seed = 1; seed <= 50; seed += 1) {
    const a = buildLevel(seed);
    const b = buildLevel(seed);
    assert.deepEqual(a.project, b.project, `seed ${seed} is not reproducible`);
    for (const wall of a.walls) {
      for (const point of points) assert.equal(rectNearPoint(wall, point, CLEARANCE), false, `seed ${seed}: ${wall.id} too near ${JSON.stringify(point)}`);
    }
  }
  assert.notDeepEqual(buildLevel(1).project, buildLevel(2).project);
});
