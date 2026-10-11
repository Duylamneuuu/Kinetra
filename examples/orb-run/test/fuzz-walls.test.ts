import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_INVARIANTS,
  ORB_RUN_PLAYER_RADIUS,
  ORB_RUN_SCENE_ID,
  OrbRunInvariantMonitor,
  checkOrbRunSaveResume,
  comparableOrbRunState,
  createOrbRunProject,
  distanceToWall,
  driveOrbRunFuzz,
  orbRunWallComponents,
  playOrbRunReplay,
  readOrbRunWalls,
  runOrbRunFuzz,
  runOrbRunFuzzCampaign,
  startOrbRunSimulation,
  summarizeOrbRun,
  type OrbRunFuzzStrategy,
  type OrbRunFuzzViolation,
} from "../src/index.js";

interface WallSpec {
  id: string;
  centre: { x: number; z: number };
  width: number;
  depth: number;
}

/** The shipped level plus walls authored through the typed command bus (`entity.create`). */
function withWalls(walls: readonly WallSpec[]): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  walls.forEach((wall, index) => {
    const result = bus.execute({
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
    assert.equal(result.ok, true);
  });
  return bus.snapshot().project;
}

/** A 0.6 m wall along x = -2 that cuts the arena in two with a gap at the top edge. */
const SPLIT: WallSpec[] = [{ id: "wall-a", centre: { x: -2, z: -0.75 }, width: 0.6, depth: 9.5 }];
/** The exit corner (4, 4) closed off by two walls that run past the arena edge. */
const CAGE: WallSpec[] = [
  { id: "wall-a", centre: { x: 2.4, z: 4.5 }, width: 0.4, depth: 4 },
  { id: "wall-b", centre: { x: 4.5, z: 2.4 }, width: 4, depth: 0.4 },
];
/** A few pillars scattered in the open field, so contact is frequent from every direction. */
const PILLARS: WallSpec[] = [
  { id: "pillar-1", centre: { x: 0, z: 0 }, width: 1.2, depth: 1.2 },
  { id: "pillar-2", centre: { x: 2.5, z: -2 }, width: 0.8, depth: 2.4 },
  { id: "pillar-3", centre: { x: -3, z: 2.5 }, width: 2.4, depth: 0.8 },
];

const LEVELS: Array<{ name: string; walls: WallSpec[] }> = [
  { name: "split", walls: SPLIT },
  { name: "cage", walls: CAGE },
  { name: "pillars", walls: PILLARS },
];

function describeViolations(violations: readonly OrbRunFuzzViolation[]): string {
  return violations.map((violation) => `step ${violation.step} ${violation.invariant}: ${violation.message}`).join("\n");
}

test("the invariant list documents player_clear_of_walls", () => {
  assert.ok((ORB_RUN_INVARIANTS as readonly string[]).includes("player_clear_of_walls"));
  assert.equal(new Set(ORB_RUN_INVARIANTS).size, ORB_RUN_INVARIANTS.length);
});

test("fuzz campaigns on walled levels keep every invariant, including the new wall one", async () => {
  const strategies: OrbRunFuzzStrategy[] = ["random", "seek", "mixed"];
  for (const level of LEVELS) {
    const project = withWalls(level.walls);
    for (const strategy of strategies) {
      const campaign = await runOrbRunFuzzCampaign({ firstSeed: 300, count: 6, steps: 900, strategy, project });
      assert.deepEqual(
        campaign.failures.map((failure) => `${level.name}/${strategy}#${failure.seed}\n${describeViolations(failure.violations)}`),
        [],
        `${level.name}/${strategy}`,
      );
    }
  }
});

test("the fuzzer really leans on the walls: the player gets to the wall face and never into it", async () => {
  for (const level of LEVELS) {
    const project = withWalls(level.walls);
    const walls = readOrbRunWalls(project.scenes.find((scene) => scene.id === ORB_RUN_SCENE_ID)!.entities);
    assert.equal(walls.length, level.walls.length);
    let touching = 0;
    let closest = Infinity;
    for (let seed = 1; seed <= 12; seed += 1) {
      const simulation = await startOrbRunSimulation(project);
      try {
        simulation.onStep(() => {
          const [x, , z] = summarizeOrbRun(simulation).player;
          const nearest = Math.min(...walls.map((wall) => distanceToWall(wall, x, z)));
          closest = Math.min(closest, nearest);
          // Sliding stops exactly at the radius; allow float noise but nothing below it.
          assert.ok(nearest >= ORB_RUN_PLAYER_RADIUS - 1e-6, `${level.name} seed ${seed}: ${nearest} m from a wall`);
          if (nearest < ORB_RUN_PLAYER_RADIUS + 0.05) touching += 1;
        });
        driveOrbRunFuzz(simulation, { seed, steps: 600, strategy: "random" });
      } finally {
        await simulation.dispose();
      }
    }
    assert.ok(touching > 20, `${level.name}: only ${touching} steps spent against a wall (closest ${closest})`);
  }
});

test("walled recordings replay to the same digests and resume from a save at any step", async () => {
  const project = withWalls(PILLARS);
  const result = await runOrbRunFuzz({ seed: 77, steps: 800, strategy: "random", project });
  assert.equal(result.ok, true, describeViolations(result.violations));

  // The recording alone reproduces the run -- but only against the same level.
  const replayed = await playOrbRunReplay(JSON.parse(JSON.stringify(result.replay)), { project });
  assert.equal(replayed.verified, true);
  assert.equal(replayed.finalDigest, result.finalDigest);
  const wrongLevel = await playOrbRunReplay(JSON.parse(JSON.stringify(result.replay)));
  assert.equal(wrongLevel.verified, false, "the same inputs without the pillars must not reproduce the run");

  let expected: ReturnType<typeof comparableOrbRunState> | undefined;
  await playOrbRunReplay(result.replay, {
    project,
    onStep: (simulation) => {
      if (simulation.step === result.replay.totalSteps) expected = comparableOrbRunState(simulation);
    },
  });
  assert.ok(expected);
  const total = result.replay.totalSteps;
  for (const saveStep of [1, 37, Math.floor(total / 3), Math.floor(total / 2), total - 1]) {
    const resumed = await checkOrbRunSaveResume(result.replay, saveStep, expected, { project });
    assert.deepEqual(resumed, { saveStep, equal: true, differences: [] }, `save at ${saveStep}`);
  }
});

test("the monitor catches a player placed inside a wall, and only on a level that has one", async () => {
  const project = withWalls(SPLIT);
  const walled = await startOrbRunSimulation(project);
  try {
    const monitor = new OrbRunInvariantMonitor(walled);
    walled.advance(2);
    assert.equal(monitor.ok, true, describeViolations(monitor.violations));
    walled.restorePosition(ORB_RUN_ENTITY.player, [-2, 0, 0]); // the middle of the wall
    walled.advance(1);
    assert.deepEqual(
      monitor.violations.map((violation) => violation.invariant),
      ["player_clear_of_walls"],
    );
    assert.match(monitor.violations[0]!.message, /overlaps a wall/);
  } finally {
    await walled.dispose();
  }

  const open = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(open);
    open.restorePosition(ORB_RUN_ENTITY.player, [-2, 0, 0]);
    open.advance(1);
    assert.equal(monitor.ok, true, "no wall there on the shipped level");
  } finally {
    await open.dispose();
  }
});

test("touching a wall face is legal; one centimetre inside the radius is not", async () => {
  const project = withWalls(SPLIT);
  const simulation = await startOrbRunSimulation(project);
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    const faceX = -2 + 0.3 + ORB_RUN_PLAYER_RADIUS; // wall centre + half width + circle radius
    simulation.restorePosition(ORB_RUN_ENTITY.player, [faceX, 0, 0]);
    simulation.advance(1);
    assert.equal(monitor.ok, true, describeViolations(monitor.violations));
    simulation.restorePosition(ORB_RUN_ENTITY.player, [faceX - 0.01, 0, 0]);
    simulation.advance(1);
    assert.ok(monitor.violations.some((violation) => violation.invariant === "player_clear_of_walls"));
  } finally {
    await simulation.dispose();
  }
});
