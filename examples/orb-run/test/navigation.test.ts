import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_ORB_IDS,
  ORB_RUN_PLAYER_RADIUS,
  ORB_RUN_SCENE_ID,
  OrbRunWallError,
  analyzeOrbRunLevel,
  circleHitsWall,
  createOrbRunProject,
  orbRunWallComponents,
  readOrbRunWalls,
  resolveWallMotion,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkStraightTo,
  type OrbRunWall,
} from "../src/index.js";
import { densifyRoute, followOrbRunRoute, planOrbRunRoute } from "../src/navigation.js";

const WALL_A = "wall-a";
const WALL_B = "wall-b";

/** The shipped level plus walls authored through the typed command bus (`entity.create`). */
function withWalls(walls: Array<{ id: string; centre: { x: number; z: number }; width: number; depth: number }>): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  walls.forEach((wall, index) => {
    bus.execute({
      requestId: `wall-${index}`,
      command: "entity.create",
      expectedProjectRevision: bus.revision,
      payload: {
        sceneId: ORB_RUN_SCENE_ID,
        entity: {
          id: wall.id,
          name: `Wall ${wall.id}`,
          components: orbRunWallComponents(wall.centre, { width: wall.width, depth: wall.depth }) as ComponentMap,
        },
      },
    });
  });
  return bus.snapshot().project;
}

/**
 * A 0.6 m wall along x = -2 from z = -5.5 to z = 4: it cuts the arena in two with only
 * a gap at the top edge, so the player (left) must go round it to reach orbs B and A.
 */
const SPLIT = [{ id: WALL_A, centre: { x: -2, z: -0.75 }, width: 0.6, depth: 9.5 }];
/** The exit corner (4, 4) closed off by two walls that run past the arena edge. */
const CAGE = [
  { id: WALL_A, centre: { x: 2.4, z: 4.5 }, width: 0.4, depth: 4 },
  { id: WALL_B, centre: { x: 4.5, z: 2.4 }, width: 4, depth: 0.4 },
];

function wallOf(centre: { x: number; z: number }, half: { w: number; d: number }): OrbRunWall {
  return { entityId: "w", x: centre.x, z: centre.z, halfWidth: half.w, halfDepth: half.d };
}

test("wall geometry: circles touching a wall are free, overlapping ones are not", () => {
  const wall = wallOf({ x: 0, z: 0 }, { w: 0.5, d: 2 });
  assert.equal(circleHitsWall([wall], 0.9, 0), false); // exactly radius (0.4) away from the face at 0.5
  assert.equal(circleHitsWall([wall], 0.89, 0), true);
  assert.equal(circleHitsWall([wall], 0.7, 2.5), false); // beyond the end cap
  assert.equal(circleHitsWall([wall], 0.5, 2.3), true); // corner within the radius
  assert.equal(circleHitsWall([], 0, 0), false);
  assert.equal(ORB_RUN_PLAYER_RADIUS, 0.4);
});

test("wall motion slides along a wall and passes through when there are no walls", () => {
  const wall = wallOf({ x: 0, z: 0 }, { w: 0.5, d: 3 });
  // Heading diagonally into the face: x is dropped, z slides.
  assert.deepEqual(resolveWallMotion([wall], { x: -1, z: -1 }, { x: -0.9, z: -0.9 }), { x: -0.9, z: -0.9 });
  assert.deepEqual(resolveWallMotion([wall], { x: -0.9, z: 0 }, { x: -0.7, z: 0.2 }), { x: -0.9, z: 0.2 });
  assert.deepEqual(resolveWallMotion([wall], { x: -0.9, z: 0 }, { x: -0.7, z: 0 }), { x: -0.9, z: 0 });
  assert.deepEqual(resolveWallMotion([], { x: 1, z: 2 }, { x: 3, z: 4 }), { x: 3, z: 4 });
});

test("readOrbRunWalls: the shipped level has none; malformed walls are reported together", () => {
  const shipped = createOrbRunProject().scenes[0]!;
  assert.deepEqual(readOrbRunWalls(shipped.entities), []);

  const walls = readOrbRunWalls(
    [
      { id: "b", components: orbRunWallComponents({ x: 1, z: 2 }, { width: 2, depth: 4 }) },
      { id: "a", components: orbRunWallComponents({ x: -1, z: 0 }, { width: 1, depth: 1 }) },
    ] as never,
  );
  assert.deepEqual(walls.map((wall) => wall.entityId), ["a", "b"]); // sorted by id
  assert.deepEqual(walls[1], { entityId: "b", x: 1, z: 2, halfWidth: 1, halfDepth: 2 });

  assert.throws(
    () =>
      readOrbRunWalls([
        { id: "bad1", components: { Transform: { position: [0, 0, 0] }, OrbRunWall: { halfWidth: 0, halfDepth: 1 } } },
        { id: "bad2", components: { OrbRunWall: { halfWidth: 1, halfDepth: 1 } } },
        { id: "bad3", components: { Transform: { position: [0, 0, 0] }, OrbRunWall: "wall" } },
      ] as never),
    (error: unknown) => {
      assert.ok(error instanceof OrbRunWallError);
      assert.deepEqual(error.issues.map((issue) => issue.entityId), ["bad1", "bad2", "bad3"]);
      return true;
    },
  );
});

test("the player stops at a wall (slides along it) and the shipped level is unaffected", async () => {
  const simulation = await startOrbRunSimulation(withWalls(SPLIT));
  // Walk right along z = -4 from x = -4: the wall face is at x = -2.3, the player stops 0.4 m short of it.
  walkStraightTo(simulation, { x: 3, z: -4 }, { maxSteps: 400 });
  const position = simulation.getPosition(ORB_RUN_ENTITY.player)!;
  assert.ok(position[0] <= -2.7 + 1e-9 && position[0] >= -2.9, `stopped at x=${position[0]}`);
  assert.ok(Math.abs(position[2] - -4) < 1e-9);
  assert.equal(summarizeOrbRun(simulation).collectedCount, 0);

  // Diagonal into the wall slides along it.
  walkStraightTo(simulation, { x: 3, z: -1 }, { maxSteps: 400 });
  const slid = simulation.getPosition(ORB_RUN_ENTITY.player)!;
  assert.ok(slid[0] < -2.6, "still left of the wall");
  assert.ok(slid[2] > -2, "slid up along the wall face");
});

test("level check: walls keep the lower bound but withdraw the straight-line claim; a player inside a wall is an error", () => {
  const plain = analyzeOrbRunLevel(createOrbRunProject());
  assert.equal(plain.verdict, "comfortable");
  assert.deepEqual(plain.walls, []);

  const report = analyzeOrbRunLevel(withWalls(SPLIT));
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "unproven");
  assert.equal(report.playtestSeconds, null);
  assert.equal(report.slackSeconds, null);
  assert.equal(report.route, null);
  assert.equal(report.lowerBoundSeconds, plain.lowerBoundSeconds);
  assert.deepEqual(report.diagnostics.map((entry) => entry.code), ["walls_present"]);
  assert.equal(report.walls.length, 1);

  const trapped = analyzeOrbRunLevel(withWalls([{ id: WALL_A, centre: { x: -4, z: -4 }, width: 2, depth: 2 }]));
  assert.equal(trapped.ok, false);
  assert.deepEqual(trapped.diagnostics.map((entry) => entry.code), ["player_in_wall"]);
  assert.equal(trapped.diagnostics[0]!.entityId, ORB_RUN_ENTITY.player);

  const broken = createOrbRunProject();
  broken.scenes[0]!.entities.push({ id: "bad-wall", name: "Bad", components: { OrbRunWall: { halfWidth: -1, halfDepth: 1 } } } as never);
  const invalid = analyzeOrbRunLevel(broken);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.diagnostics.map((entry) => entry.code), ["wall_invalid"]);
});

test("route plan without walls is the straight-line optimum over the three orbs and the exit", async () => {
  const plan = await planOrbRunRoute(createOrbRunProject());
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.wallCount, 0);
  assert.equal(plan.orderExact, true);
  assert.equal(plan.legs.length, 4);
  assert.equal(plan.legs.at(-1)!.to, ORB_RUN_ENTITY.exit);
  assert.deepEqual([...plan.orbIds].sort(), [...ORB_RUN_ORB_IDS].sort());
  // Euclidean lower route: start (-4,-4) -> A (4,-4) -> B (0,0) -> C (-4,4) -> exit (4,4) = 8 + 5.657 + 5.657 + 8 = 27.31.
  // The reverse order costs the same; any other order is longer. Navmesh snapping may shift it by well under a cell.
  assert.ok(Math.abs(plan.lengthMeters! - 27.314) < 0.3, `length ${plan.lengthMeters}`);
  assert.ok(plan.estimatedSeconds! > 6.5 && plan.estimatedSeconds! < 7.2);
  assert.ok(plan.slackSeconds! > 12);
});

test("route plan walks around a wall and a bot following it wins where the straight bot is stuck", async () => {
  const project = withWalls(SPLIT);
  const plan = await planOrbRunRoute(project);
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.wallCount, 1);

  // No point of the planned route (sampled every few centimetres) is inside the wall for a player circle.
  const walls = readOrbRunWalls(project.scenes[0]!.entities);
  for (const point of densifyRoute(plan.path, 0.05)) {
    assert.equal(circleHitsWall(walls, point.x, point.z), false, `route enters the wall at ${point.x},${point.z}`);
  }
  // It is longer than the open-field route, and the route goes round the open end (z > 4).
  const open = await planOrbRunRoute(createOrbRunProject());
  assert.ok(plan.lengthMeters! > open.lengthMeters! + 0.8, `${plan.lengthMeters} vs ${open.lengthMeters}`);
  assert.ok(plan.path.some((point) => point.z > 4 && point.x > -2.6 && point.x < -1.4), "passes the wall's open end");

  // Straight bot (open-field route) is stuck behind the wall and collects nothing but whatever it can reach.
  const straight = await startOrbRunSimulation(project);
  const field = analyzeOrbRunLevel(createOrbRunProject()).route!;
  const finished = () => summarizeOrbRun(straight).status !== "playing";
  for (const waypoint of field.waypoints) {
    if (finished()) break;
    walkStraightTo(straight, waypoint, { stopWhen: finished, maxSteps: 900 });
  }
  assert.notEqual(summarizeOrbRun(straight).status, "won", "the open-field bot must not win through a wall");

  // The planned route wins, picks up every orb, and lands near the estimate.
  const simulation = await startOrbRunSimulation(project);
  const done = () => summarizeOrbRun(simulation).status !== "playing";
  const followed = followOrbRunRoute(simulation, plan, { stopWhen: done });
  simulation.advance(2);
  const summary = summarizeOrbRun(simulation);
  assert.equal(summary.status, "won", JSON.stringify({ summary, followed }));
  assert.equal(summary.collectedCount, 3);
  assert.ok(summary.elapsedSeconds >= plan.estimatedSeconds! - 0.5);
  assert.ok(summary.elapsedSeconds < plan.estimatedSeconds! * 1.5 + 1, `${summary.elapsedSeconds}s vs estimate ${plan.estimatedSeconds}s`);
  assert.ok(summary.elapsedSeconds < 20);
});

test("a route plan is deterministic and independent of the navmesh cell size within tolerance", async () => {
  const project = withWalls(SPLIT);
  const a = await planOrbRunRoute(project);
  const b = await planOrbRunRoute(project);
  assert.deepEqual(a, b);
  const coarse = await planOrbRunRoute(project, { cellSize: 0.2 });
  assert.equal(coarse.ok, true);
  assert.deepEqual(coarse.orbIds, a.orbIds);
  assert.ok(Math.abs(coarse.lengthMeters! - a.lengthMeters!) < 1, `${coarse.lengthMeters} vs ${a.lengthMeters}`);
});

test("walls that close off the exit give route_blocked naming the exit, and an invalid level gives level_invalid", async () => {
  const caged = await planOrbRunRoute(withWalls(CAGE));
  assert.equal(caged.ok, false);
  assert.deepEqual(caged.diagnostics.map((entry) => [entry.code, entry.entityId]), [["route_blocked", ORB_RUN_ENTITY.exit]]);
  assert.equal(caged.lengthMeters, null);
  assert.deepEqual(caged.legs, []);

  const trapped = await planOrbRunRoute(withWalls([{ id: WALL_A, centre: { x: -4, z: -4 }, width: 2, depth: 2 }]));
  assert.equal(trapped.ok, false);
  assert.equal(trapped.diagnostics[0]!.code, "level_invalid");
  assert.match(trapped.diagnostics[0]!.message, /player_in_wall/);
});

test("densifyRoute keeps corners, spaces points and rejects a bad spacing", () => {
  const points = densifyRoute([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0.5 }], 0.25);
  assert.deepEqual(points.map((point) => [point.x, point.z]), [[0, 0], [0.25, 0], [0.5, 0], [0.75, 0], [1, 0], [1, 0.25], [1, 0.5]]);
  assert.deepEqual(densifyRoute([], 0.25), []);
  assert.throws(() => densifyRoute([{ x: 0, z: 0 }], 0), RangeError);
});
