import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";
import { AcceptanceRunner, acceptanceManifestSchema, type AcceptanceManifest } from "@kinetra/verification";

import {
  ORB_RUN_ACTION,
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_PLAYER_RADIUS,
  ORB_RUN_SCENE_ID,
  OrbRunHeadlessProbe,
  OrbRunInvariantMonitor,
  OrbRunSaveError,
  analyzeOrbRunLevel,
  captureOrbRunSave,
  circleHitsWall,
  createOrbRunProject,
  orbRunWallComponents,
  readOrbRunWalls,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  validateOrbRunSave,
} from "../src/index.js";

/**
 * Slice 36 (the "Not proven" of slice 34): a wall created with `entity.create` under the player, then `input` out --
 * through the real `OrbRunPlayer` script, the headless simulation, the level check, the invariant monitor, save
 * validation and an `AcceptanceManifest`, instead of `resolveWallMotion` alone. The player starts at (-4, -4); the wall
 * is a 2 x 2 m box centred on that spot, so the 0.4 m circle overlaps it from the first step.
 */

const START = { x: -4, z: -4 };
const WALL = { id: "wall-under-player", centre: START, width: 2, depth: 2 };
const STEP_METRES = ORB_RUN_DEFAULT_RULES.playerSpeed / 30;
/** East face of the wall plus the circle radius: from here on the player is clear. */
const CLEAR_X = START.x + WALL.width / 2 + ORB_RUN_PLAYER_RADIUS;

function withWallUnderPlayer(): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  const result = bus.execute({
    requestId: "wall-under-player",
    command: "entity.create",
    expectedProjectRevision: bus.revision,
    payload: {
      sceneId: ORB_RUN_SCENE_ID,
      entity: {
        id: WALL.id,
        name: "Wall under player",
        components: orbRunWallComponents(WALL.centre, { width: WALL.width, depth: WALL.depth }) as ComponentMap,
      },
    },
  });
  assert.equal(result.ok, true);
  return bus.snapshot().project;
}

function wallsOf(project: ProjectDocument) {
  return readOrbRunWalls(project.scenes.find((scene) => scene.id === ORB_RUN_SCENE_ID)!.entities);
}

test("the level check says the player starts inside the wall, and the wall really overlaps the start", () => {
  const project = withWallUnderPlayer();
  const walls = wallsOf(project);
  assert.equal(walls.length, 1);
  assert.equal(circleHitsWall(walls, START.x, START.z), true);
  const report = analyzeOrbRunLevel(project);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "player_in_wall" && entry.severity === "error"));
});

test("holding moveRight walks the real player script out of the wall, one fixed step at a time, and never deeper", async () => {
  const project = withWallUnderPlayer();
  const walls = wallsOf(project);
  const simulation = await startOrbRunSimulation(project);
  try {
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    let escapedAt = -1;
    let previousX = START.x;
    for (let step = 1; step <= 40; step += 1) {
      simulation.advance(1);
      const [x, , z] = summarizeOrbRun(simulation).player;
      assert.equal(z, START.z, "no sideways drift");
      assert.ok(Math.abs(x - previousX - STEP_METRES) < 1e-9, `step ${step} moved ${x - previousX}, not ${STEP_METRES}`);
      previousX = x;
      if (escapedAt < 0 && !circleHitsWall(walls, x, z)) escapedAt = step;
    }
    assert.ok(escapedAt > 0, "the player got out");
    assert.equal(escapedAt, Math.ceil((CLEAR_X - START.x - 1e-9) / STEP_METRES), "out on the first step that ends at or beyond the clear line");
    assert.equal(summarizeOrbRun(simulation).status, "playing");
  } finally {
    await simulation.dispose();
  }
});

test("every other direction is refused while overlapping when it goes deeper, and sliding along the face is allowed", async () => {
  const project = withWallUnderPlayer();
  const simulation = await startOrbRunSimulation(project);
  try {
    // Put the player 0.2 m inside the east face (still overlapping: the circle reaches 0.2 m into the wall).
    simulation.restorePosition(ORB_RUN_ENTITY.player, [START.x + 1.2, 1, START.z]);
    simulation.setAction(ORB_RUN_ACTION.moveLeft, 1);
    simulation.advance(30);
    const stuck = simulation.getPosition(ORB_RUN_ENTITY.player)!;
    assert.deepEqual(stuck, [START.x + 1.2, 1, START.z], "moving towards the wall's centre never moves the player");
    simulation.releaseAllActions();

    // Sliding along the east face (z only) is allowed: clearance to the face does not shrink.
    simulation.setAction(ORB_RUN_ACTION.moveBackward, 1);
    simulation.advance(6);
    const slid = simulation.getPosition(ORB_RUN_ENTITY.player)!;
    assert.equal(slid[0], START.x + 1.2);
    assert.ok(slid[2] > START.z, "the player slid along the wall");
  } finally {
    await simulation.dispose();
  }
});

test("the invariant monitor reports the overlap only on the steps the player is still inside, then goes quiet", async () => {
  const project = withWallUnderPlayer();
  const simulation = await startOrbRunSimulation(project);
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(40);
    const insideSteps = Math.ceil((CLEAR_X - START.x - 1e-9) / STEP_METRES) - 1;
    assert.ok(insideSteps > 0);
    const reported = monitor.violations.filter((violation) => violation.invariant === "player_clear_of_walls");
    assert.equal(reported.length, insideSteps, "one report per step that ended inside the wall");
    assert.deepEqual(
      reported.map((violation) => violation.step),
      Array.from({ length: insideSteps }, (_, index) => index + 1),
    );
    assert.equal(monitor.violations.length, reported.length, "no other invariant is hurt by an overlap the player is leaving");
  } finally {
    await simulation.dispose();
  }
});

test("a save taken while the player is inside the wall is refused; one taken after walking out restores", async () => {
  const project = withWallUnderPlayer();
  const simulation = await startOrbRunSimulation(project);
  try {
    const inside = captureOrbRunSave(simulation);
    const issues = validateOrbRunSave(simulation, inside);
    assert.ok(
      issues.some((issue) => issue.path.includes(ORB_RUN_ENTITY.player)),
      `the position of the player is refused: ${JSON.stringify(issues)}`,
    );
    await assert.rejects(restoreOrbRunSave(simulation, inside), OrbRunSaveError);

    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(30);
    simulation.releaseAllActions();
    const outside = captureOrbRunSave(simulation);
    assert.deepEqual(validateOrbRunSave(simulation, outside), []);
    simulation.advance(10);
    await restoreOrbRunSave(simulation, JSON.parse(JSON.stringify(outside)));
    assert.deepEqual(captureOrbRunSave(simulation), outside, "quick-load of the post-escape save is the identity");
  } finally {
    await simulation.dispose();
  }
});

function manifest(steps: Array<Record<string, unknown>>): AcceptanceManifest {
  return acceptanceManifestSchema.parse({
    schemaVersion: 1,
    suite: "orb-run.wall-under-player",
    seed: 0,
    target: "runtime",
    steps: [{ type: "runtime.start", sceneId: ORB_RUN_SCENE_ID }, ...steps],
  });
}

test("an AcceptanceManifest pins the whole story: the diagnostic, then the walk out", async () => {
  const project = withWallUnderPlayer();
  const diagnosticIndex = analyzeOrbRunLevel(project).diagnostics.findIndex((entry) => entry.code === "player_in_wall");
  assert.ok(diagnosticIndex >= 0);
  const holdSteps = 30;
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe({ project })).run(
    manifest([
      { type: "assert.equal", path: "state.level.ok", expected: false },
      { type: "assert.equal", path: `state.level.diagnostics.${diagnosticIndex}.code`, expected: "player_in_wall" },
      { type: "assert.equal", path: "state.level.walls.0.entityId", expected: WALL.id },
      { type: "assert.near", path: "state.entities.Player.position.0", expected: START.x, tolerance: 1e-9 },
      { type: "input", action: "player.moveRight", phase: "hold", durationMs: holdSteps * (1000 / 30) },
      { type: "assert.near", path: "state.entities.Player.position.0", expected: START.x + holdSteps * STEP_METRES, tolerance: 1e-6 },
      { type: "assert.near", path: "state.entities.Player.position.2", expected: START.z, tolerance: 1e-9 },
      { type: "assert.equal", path: "state.game.status", expected: "playing" },
    ]),
  );
  const failed = report.steps.find((step) => !step.passed);
  assert.equal(report.passed, true, failed ? `${failed.index} ${failed.type}: ${failed.message ?? ""}` : "");

  // The same manifest on the shipped level (no wall) fails at the very first read: the claim is about THIS level.
  const open = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([{ type: "assert.equal", path: "state.level.walls.0.entityId", expected: WALL.id }]),
  );
  assert.equal(open.passed, false);
});
