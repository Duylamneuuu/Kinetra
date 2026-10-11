import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";
import { AcceptanceRunner, acceptanceManifestSchema, type AcceptanceManifest } from "@kinetra/verification";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_SCENE_ID,
  OrbRunHeadlessProbe,
  createOrbRunProject,
  orbRunWallComponents,
} from "../src/index.js";
import { orbRunAcceptanceDirectory } from "../src/acceptance-suite.js";
import { createOrbRunNavigationProbe, planOrbRunRoute } from "../src/navigation.js";

const WALL_A = "wall-a";
const WALL_B = "wall-b";

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

/** A 0.6 m wall along x = -2 from z = -5.5 to z = 4: the player (left) must go round its open end. */
const SPLIT = [{ id: WALL_A, centre: { x: -2, z: -0.75 }, width: 0.6, depth: 9.5 }];
/** The exit corner (4, 4) closed off by two walls that run past the arena edge. */
const CAGE = [
  { id: WALL_A, centre: { x: 2.4, z: 4.5 }, width: 0.4, depth: 4 },
  { id: WALL_B, centre: { x: 4.5, z: 2.4 }, width: 4, depth: 0.4 },
];

function manifest(suite: string, steps: Array<Record<string, unknown>>): AcceptanceManifest {
  return acceptanceManifestSchema.parse({
    schemaVersion: 1,
    suite,
    seed: 0,
    target: "runtime",
    steps: [{ type: "runtime.start", sceneId: ORB_RUN_SCENE_ID }, ...steps],
  });
}

const equal = (path: string, expected: unknown): Record<string, unknown> => ({ type: "assert.equal", path, expected });
const near = (path: string, expected: number, tolerance: number): Record<string, unknown> => ({
  type: "assert.near",
  path,
  expected,
  tolerance,
});

async function shippedManifest(name: string): Promise<AcceptanceManifest> {
  return acceptanceManifestSchema.parse(JSON.parse(await readFile(join(orbRunAcceptanceDirectory(), name), "utf8")));
}

function failedStep(report: Awaited<ReturnType<AcceptanceRunner["run"]>>): { index: number; type: string; message: string } | undefined {
  const step = report.steps.find((candidate) => !candidate.passed);
  return step ? { index: step.index, type: step.type, message: step.message ?? "" } : undefined;
}

test("the shipped navigation manifest passes on the navigation probe and fails loudly on a probe without a planner", async () => {
  const navigation = await shippedManifest("navigation.acceptance.json");
  const passing = await new AcceptanceRunner(createOrbRunNavigationProbe()).run(navigation);
  assert.equal(passing.passed, true, JSON.stringify(failedStep(passing)));

  const plain = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(navigation);
  assert.equal(plain.passed, false);
  const failure = failedStep(plain)!;
  assert.equal(failure.index, 1, "the first read of state.navigation is the failing step");
  assert.match(failure.message, /state\.navigation\.ok/);
});

test("state.navigation is exactly the plan planOrbRunRoute prices, and only exists with a planner", async () => {
  const project = withWalls(SPLIT);
  const probe = createOrbRunNavigationProbe({ project });
  assert.deepEqual((await probe.snapshot()).state, {}, "nothing before the game starts");
  await probe.start(ORB_RUN_SCENE_ID, 0);
  const snapshot = (await probe.snapshot()).state as Record<string, unknown>;
  assert.deepEqual(snapshot.navigation, await planOrbRunRoute(project));

  const bare = new OrbRunHeadlessProbe({ project });
  await bare.start(ORB_RUN_SCENE_ID, 0);
  assert.equal("navigation" in ((await bare.snapshot()).state as Record<string, unknown>), false);
  await probe.stop();
  await bare.stop();
});

test("a walled level: the wall and the detour are asserted from a manifest, and the player really stops at the wall", async () => {
  const open = await planOrbRunRoute(createOrbRunProject());
  const plan = await planOrbRunRoute(withWalls(SPLIT));
  const report = await new AcceptanceRunner(createOrbRunNavigationProbe({ project: withWalls(SPLIT) })).run(
    manifest("orb-run.navigation-walls", [
      // The level check sees the wall and stops claiming the straight-line time.
      equal("state.level.ok", true),
      equal("state.level.verdict", "unproven"),
      equal("state.level.walls.0.entityId", WALL_A),
      equal("state.level.walls.0.x", -2),
      equal("state.level.walls.0.halfWidth", 0.3),
      equal("state.level.walls.0.halfDepth", 4.75),
      equal("state.level.route", null),
      equal("state.level.diagnostics.0.code", "walls_present"),
      // The navmesh route exists, goes round the wall's open end, and is longer than the open-field one.
      equal("state.navigation.ok", true),
      equal("state.navigation.wallCount", 1),
      near("state.navigation.lengthMeters", plan.lengthMeters!, 1e-9),
      near("state.navigation.slackSeconds", plan.slackSeconds!, 1e-9),
      // Walking straight at the wall for 1.5 s (6 m of free space) stops within one step (0.133 m) of 0.4 m short of its face at x = -2.3.
      { type: "input", action: "player.moveRight", phase: "hold", durationMs: 1500 },
      near("state.entities.Player.position.0", -2.8, 0.1001),
      near("state.entities.Player.position.2", -4, 1e-9),
      equal("state.game.collectedCount", 0),
      equal("state.game.status", "playing"),
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(failedStep(report)));
  assert.ok(plan.lengthMeters! > open.lengthMeters! + 0.8, `${plan.lengthMeters} vs ${open.lengthMeters}`);
});

test("walls that cage the exit read as route_blocked from a manifest while the level check still says ok", async () => {
  const report = await new AcceptanceRunner(createOrbRunNavigationProbe({ project: withWalls(CAGE) })).run(
    manifest("orb-run.navigation-caged", [
      equal("state.level.ok", true),
      equal("state.level.walls.1.entityId", WALL_B),
      equal("state.navigation.ok", false),
      equal("state.navigation.diagnostics.0.code", "route_blocked"),
      equal("state.navigation.diagnostics.0.entityId", ORB_RUN_ENTITY.exit),
      equal("state.navigation.lengthMeters", null),
      equal("state.navigation.orbIds", []),
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(failedStep(report)));
});

test("a manifest that disagrees with the plan fails on the navigation step that is wrong", async () => {
  const report = await new AcceptanceRunner(createOrbRunNavigationProbe({ project: withWalls(SPLIT) })).run(
    manifest("orb-run.navigation-wrong", [
      equal("state.navigation.ok", true),
      near("state.navigation.lengthMeters", 27.314, 0.3), // the open-field length: the wall makes it longer
    ]),
  );
  assert.equal(report.passed, false);
  const failure = failedStep(report)!;
  assert.equal(failure.index, 2);
  assert.equal(failure.type, "assert.near");
  assert.match(failure.message, /state\.navigation\.lengthMeters/);
});

test("the planner runs once per probe, a throwing planner fails the snapshot instead of hiding the plan, and navigation never touches the replay digest", async () => {
  let calls = 0;
  const counting = new OrbRunHeadlessProbe({
    routePlanner: async (project) => {
      calls += 1;
      return planOrbRunRoute(project);
    },
  });
  await counting.start(ORB_RUN_SCENE_ID, 0);
  await counting.snapshot();
  await counting.step(3);
  await counting.snapshot();
  await counting.stop();
  await counting.start(ORB_RUN_SCENE_ID, 0);
  await counting.snapshot();
  assert.equal(calls, 1, "the project does not change under a probe, so one plan serves every start");
  const withPlan = (await counting.snapshot()).state as { replay: { digest: string } };
  await counting.stop();

  const bare = new OrbRunHeadlessProbe();
  await bare.start(ORB_RUN_SCENE_ID, 0);
  const without = (await bare.snapshot()).state as { replay: { digest: string } };
  await bare.stop();
  assert.equal(withPlan.replay.digest, without.replay.digest);

  const broken = new OrbRunHeadlessProbe({
    routePlanner: async () => {
      throw new Error("navmesh exploded");
    },
  });
  await broken.start(ORB_RUN_SCENE_ID, 0);
  await assert.rejects(broken.snapshot(), /navmesh exploded/);
  await broken.stop();
});
