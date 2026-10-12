import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";
import { AcceptanceRunner, acceptanceManifestSchema, type AcceptanceManifest } from "@kinetra/verification";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  analyzeOrbRunLevel,
  createOrbRunProject,
  orbRunSlowZoneComponents,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkSecondsAlong,
  type OrbRunSlowZone,
} from "../src/index.js";
import { createOrbRunNavigationProbe, followOrbRunRoute, planOrbRunRoute } from "../src/navigation.js";

interface ZoneSpec {
  id: string;
  centre: { x: number; z: number };
  radius: number;
  speedMultiplier: number;
}

/** The shipped level plus mud authored through the typed command bus, optionally with rebalanced rules. */
function withMud(zones: readonly ZoneSpec[], rules: Record<string, number> = {}): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  zones.forEach((zone, index) => {
    const result = bus.execute({
      requestId: `zone-${index}`,
      command: "entity.create",
      expectedProjectRevision: bus.revision,
      payload: {
        sceneId: ORB_RUN_SCENE_ID,
        entity: { id: zone.id, name: `Mud ${zone.id}`, components: orbRunSlowZoneComponents(zone.centre, zone) as ComponentMap },
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

const zone = (x: number, z: number, radius: number, speedMultiplier: number): OrbRunSlowZone => ({ entityId: "z", x, z, radius, speedMultiplier });

/** Mud on the middle orb (0, 0): every visiting order has to cross it, twice. */
const MUD_ON_B: ZoneSpec[] = [{ id: "mud-b", centre: { x: 0, z: 0 }, radius: 1, speedMultiplier: 0.5 }];
/** Mud on the bottom edge (0, -4): only the orders that start towards the orb at (4, -4) cross it. */
const MUD_ON_BOTTOM: ZoneSpec[] = [{ id: "mud-bottom", centre: { x: 0, z: -4 }, radius: 1.5, speedMultiplier: 0.5 }];
/** A big slow lake in the middle of the arena. */
const LAKE: ZoneSpec[] = [{ id: "lake", centre: { x: 0, z: 0 }, radius: 2.5, speedMultiplier: 0.25 }];

test("walkSecondsAlong: no zones is length over speed, mud prices each stretch at its own speed", () => {
  const path = [{ x: -2, z: 0 }, { x: 2, z: 0 }];
  assert.equal(walkSecondsAlong(path, 4, []), 1);
  assert.equal(walkSecondsAlong([], 4, [zone(0, 0, 1, 0.5)]), 0);
  assert.equal(walkSecondsAlong([{ x: 1, z: 1 }], 4, [zone(0, 0, 1, 0.5)]), 0);
  // 1 m outside each side at 4 m/s = 0.5 s, 2 m inside at 2 m/s = 1 s.
  assert.ok(Math.abs(walkSecondsAlong(path, 4, [zone(0, 0, 1, 0.5)]) - 1.5) < 1e-6);
  // Entirely inside: length / (speed * multiplier).
  assert.ok(Math.abs(walkSecondsAlong(path, 4, [zone(0, 0, 3, 0.25)]) - 4) < 1e-6);
  // A zone that misses the path costs nothing.
  assert.ok(Math.abs(walkSecondsAlong(path, 4, [zone(0, 5, 1, 0.1)]) - 1) < 1e-9);
  // Overlapping zones: the slowest wins where they overlap. 2 m outside both at 4 m/s (0.5 s), 1 m in the big one
  // only at 2 m/s (0.5 s), 1 m in the small one at 1 m/s (1 s).
  const both = walkSecondsAlong(path, 4, [zone(0, 0, 1, 0.5), zone(0, 0, 0.5, 0.25)]);
  assert.ok(Math.abs(both - 2) < 1e-6, `${both}`);
  // The boundary counts as inside, like the player script.
  assert.ok(Math.abs(walkSecondsAlong([{ x: 1, z: 0 }, { x: 1.0001, z: 0 }], 4, [zone(0, 0, 1, 0.5)]) - 0.0001 / 4) < 1e-6);
  assert.throws(() => walkSecondsAlong(path, 0, []), RangeError);
  assert.throws(() => walkSecondsAlong(path, Number.NaN, []), RangeError);
});

test("route plan: a level without mud reports no mud, and the plan keeps its old numbers", async () => {
  const plan = await planOrbRunRoute(createOrbRunProject());
  assert.equal(plan.slowZoneCount, 0);
  assert.equal(plan.mudSeconds, 0);
  assert.equal(plan.estimatedSeconds, Math.round((plan.lengthMeters! / 4) * 1e6) / 1e6);
});

test("route plan: mud on the middle orb costs exactly the extra seconds of the 2 m it covers", async () => {
  const open = await planOrbRunRoute(createOrbRunProject());
  const plan = await planOrbRunRoute(withMud(MUD_ON_B));
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.slowZoneCount, 1);
  // Same walkable shape: the walk is the same length. 2 m of it is at half speed: 2/2 - 2/4 = 0.5 s more.
  assert.ok(Math.abs(plan.lengthMeters! - open.lengthMeters!) < 0.05);
  assert.ok(Math.abs(plan.mudSeconds! - 0.5) < 0.08, `mud ${plan.mudSeconds}`);
  assert.ok(Math.abs(plan.estimatedSeconds! - (open.estimatedSeconds! + 0.5)) < 0.1);
  assert.ok(Math.abs(plan.slackSeconds! - (open.slackSeconds! - 0.5)) < 0.1);
  // The level check makes no playtest claim for mud; the planner is what puts a time on it.
  const level = analyzeOrbRunLevel(withMud(MUD_ON_B));
  assert.equal(level.verdict, "unproven");
  assert.equal(level.playtestSeconds, null);
});

test("route plan: the order of the orbs is chosen by time, so it walks round mud it can avoid", async () => {
  const project = withMud(MUD_ON_BOTTOM);
  const open = await planOrbRunRoute(createOrbRunProject());
  const plan = await planOrbRunRoute(project);
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  // Start (-4,-4) -> (4,-4) runs straight through the mud; start -> (-4,4) first is the same length and dry.
  const first = plan.legs[0]!.path.at(-1)!;
  assert.ok(Math.abs(first.x - -4) < 0.3 && Math.abs(first.z - 4) < 0.3, `first stop ${JSON.stringify(first)}`);
  assert.equal(plan.mudSeconds, 0);
  assert.ok(Math.abs(plan.estimatedSeconds! - open.estimatedSeconds!) < 1e-6);

  // The order it rejected really would have been slower: 3 m of the first leg at half speed.
  const zones = [zone(0, -4, 1.5, 0.5)];
  const muddy = walkSecondsAlong([{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 0, z: 0 }, { x: -4, z: 4 }, { x: 4, z: 4 }], 4, zones);
  assert.ok(Math.abs(muddy - (open.estimatedSeconds! + 0.75)) < 0.02, `${muddy} vs ${open.estimatedSeconds}`);
  assert.ok(plan.estimatedSeconds! < muddy - 0.7);
});

test("a bot following a muddy plan wins near the estimate and is slower than on open ground", async () => {
  const project = withMud(MUD_ON_B);
  const plan = await planOrbRunRoute(project);
  const run = async (target: ProjectDocument, route = plan) => {
    const simulation = await startOrbRunSimulation(target);
    const done = () => summarizeOrbRun(simulation).status !== "playing";
    followOrbRunRoute(simulation, route, { stopWhen: done });
    simulation.advance(2);
    return summarizeOrbRun(simulation);
  };
  const muddy = await run(project);
  const dry = await run(createOrbRunProject(), plan);
  assert.equal(muddy.status, "won", JSON.stringify(muddy));
  assert.equal(muddy.collectedCount, 3);
  assert.equal(dry.status, "won");
  assert.ok(muddy.elapsedSeconds > dry.elapsedSeconds + 0.3, `${muddy.elapsedSeconds}s vs ${dry.elapsedSeconds}s dry`);
  assert.ok(muddy.elapsedSeconds >= plan.estimatedSeconds! - 0.5, `${muddy.elapsedSeconds}s vs estimate ${plan.estimatedSeconds}s`);
  assert.ok(muddy.elapsedSeconds < plan.estimatedSeconds! * 1.5 + 1);
});

test("the planner predicts a mud loss: negative slack, and the same bot really runs out of clock", async () => {
  const winnable = withMud(LAKE);
  const tight = withMud(LAKE, { timeLimitSeconds: 8 });
  const ok = await planOrbRunRoute(winnable);
  const plan = await planOrbRunRoute(tight);
  assert.equal(ok.ok, true);
  assert.ok(ok.mudSeconds! > 3, `lake costs ${ok.mudSeconds}s`);
  assert.ok(ok.slackSeconds! > 0, "20 s is enough to wade through");
  assert.equal(plan.ok, true);
  assert.ok(plan.estimatedSeconds! > 8, `${plan.estimatedSeconds}s`);
  assert.ok(plan.slackSeconds! < 0);

  // Without the lake 8 s is plenty: it is the mud that loses it.
  const dry = await planOrbRunRoute(withMud([], { timeLimitSeconds: 8 }));
  assert.ok(dry.slackSeconds! > 0);

  const simulation = await startOrbRunSimulation(tight);
  const done = () => summarizeOrbRun(simulation).status !== "playing";
  followOrbRunRoute(simulation, plan, { stopWhen: done });
  assert.equal(summarizeOrbRun(simulation).status, "lost");
});

test("state.navigation carries the mud on the acceptance probe, and a manifest can pin it", async () => {
  const project = withMud(MUD_ON_B);
  const plan = await planOrbRunRoute(project);
  const manifest: AcceptanceManifest = acceptanceManifestSchema.parse({
    schemaVersion: 1,
    suite: "orb-run.navigation-mud",
    seed: 0,
    target: "runtime",
    steps: [
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.equal", path: "state.navigation.ok", expected: true },
      { type: "assert.equal", path: "state.navigation.slowZoneCount", expected: 1 },
      { type: "assert.near", path: "state.navigation.mudSeconds", expected: plan.mudSeconds, tolerance: 1e-9 },
      { type: "assert.near", path: "state.navigation.estimatedSeconds", expected: plan.estimatedSeconds, tolerance: 1e-9 },
      { type: "assert.equal", path: "state.level.verdict", expected: "unproven" },
    ],
  });
  const report = await new AcceptanceRunner(createOrbRunNavigationProbe({ project })).run(manifest);
  assert.equal(report.passed, true, JSON.stringify(report.steps.find((step) => !step.passed)));

  // The dry level fails the same manifest at the mud count: the assertion is about the level, not the plan shape.
  const dry = await new AcceptanceRunner(createOrbRunNavigationProbe()).run(manifest);
  assert.equal(dry.passed, false);
  assert.equal(dry.steps.find((step) => !step.passed)?.index, 2);
});

test("a plan for a level that is invalid still reports its mud count", async () => {
  const bus = new CommandBus(withMud(MUD_ON_B));
  const result = bus.execute({
    requestId: "rules-bad",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { timeLimitSeconds: 0 } as never },
  });
  assert.equal(result.ok, true);
  const plan = await planOrbRunRoute(bus.snapshot().project);
  assert.equal(plan.ok, false);
  assert.equal(plan.slowZoneCount, 1);
  assert.equal(plan.mudSeconds, null);
});
