import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import { cloneProject, type EntityDefinition, type ProjectDocument } from "@kinetra/project-model";
import { AcceptanceRunner, acceptanceManifestSchema } from "@kinetra/verification";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_LEVEL_EXACT_ORDER_LIMIT,
  ORB_RUN_ORB_IDS,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  OrbRunHeadlessProbe,
  analyzeOrbRunLevel,
  createOrbRunProject,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkStraightTo,
  type OrbRunLevelReport,
  type OrbRunLevelVerdict,
  type OrbRunSummary,
} from "../src/index.js";

/** The shipped project with `patch` applied to one component through the typed command bus. */
function patched(entityId: string, component: string, patch: Record<string, unknown>): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: `level-${entityId}-${component}`,
    command: "component.patch",
    payload: { entityId, component, patch: patch as never },
  });
  return bus.snapshot().project;
}

function withRules(patch: Record<string, number>): ProjectDocument {
  return patched(ORB_RUN_ENTITY.manager, ORB_RUN_RULES_COMPONENT, patch);
}

function sceneOf(project: ProjectDocument) {
  return project.scenes.find((scene) => scene.id === ORB_RUN_SCENE_ID)!;
}

function codes(report: OrbRunLevelReport): string[] {
  return report.diagnostics.map((entry) => entry.code);
}

/** Plays the level the way the analysis predicts: eight-direction input along `report.route`. */
async function playRoute(project: ProjectDocument, report: OrbRunLevelReport): Promise<OrbRunSummary> {
  const simulation = await startOrbRunSimulation(project);
  try {
    const rules = report.rules!;
    const finished = () => summarizeOrbRun(simulation).status !== "playing";
    const waypoints = report.route!.waypoints;
    // Walk to each waypoint (an orb centre, clamped into the arena) to within one step: that is what the estimate prices.
    for (const waypoint of waypoints) {
      if (finished()) break;
      walkStraightTo(simulation, waypoint, { stopWhen: finished, playerSpeed: rules.playerSpeed, maxSteps: 4000 });
    }
    // Let the manager see the final position, then let a stalled run run out the clock.
    const budget = Math.ceil(rules.timeLimitSeconds / simulation.fixedDeltaSeconds) + 2;
    for (let used = 0; used < budget && !finished(); used += 1) simulation.advance(1);
    return summarizeOrbRun(simulation);
  } finally {
    await simulation.dispose();
  }
}

test("the shipped level is comfortably winnable and says how", () => {
  const report = analyzeOrbRunLevel(createOrbRunProject());
  assert.equal(report.ok, true);
  assert.equal(report.verdict, "comfortable");
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.orbCount, 3);
  assert.equal(report.orderExact, true);
  assert.deepEqual(report.route?.orbIds, [...ORB_RUN_ORB_IDS], "A, B, C is the cheapest order");
  assert.deepEqual(report.route?.waypoints, [
    { x: 4, z: -4 },
    { x: 0, z: 0 },
    { x: -4, z: 4 },
    { x: 4, z: 4 },
  ]);
  // 8 + 4*sqrt2 + 4*sqrt2 + 8 octile metres at 4 m/s, plus 5 quantisation steps of 1/30 s.
  assert.ok(Math.abs(report.playtestSeconds! - ((16 + 8 * Math.SQRT2) / 4 + 5 / 30)) < 1e-5, String(report.playtestSeconds));
  assert.ok(report.lowerBoundSeconds! > 0 && report.lowerBoundSeconds! < report.playtestSeconds!);
  assert.equal(report.slackSeconds, Math.round((report.rules!.timeLimitSeconds - report.playtestSeconds!) * 1e6) / 1e6);
});

test("the prediction brackets a real playthrough of the shipped level", async () => {
  const project = createOrbRunProject();
  const report = analyzeOrbRunLevel(project);
  const summary = await playRoute(project, report);
  assert.equal(summary.status, "won");
  assert.equal(summary.collectedCount, 3);
  assert.ok(summary.elapsedSeconds <= report.playtestSeconds! + 1e-9, `${summary.elapsedSeconds} <= ${report.playtestSeconds}`);
  assert.ok(summary.elapsedSeconds >= report.lowerBoundSeconds!, `${summary.elapsedSeconds} >= ${report.lowerBoundSeconds}`);
});

test("an orb moved out of the arena by a patch is reported with the orb's id, and not as a crash", () => {
  const far = analyzeOrbRunLevel(patched(ORB_RUN_ENTITY.orbA, "Transform", { position: [9, 0.5, -4] }));
  assert.equal(far.ok, false);
  assert.equal(far.verdict, "invalid");
  assert.deepEqual(codes(far), ["orb_unreachable"]);
  assert.equal(far.diagnostics[0]?.entityId, ORB_RUN_ENTITY.orbA);
  assert.equal(far.diagnostics[0]?.severity, "error");
  assert.equal(far.playtestSeconds, null);
  assert.equal(far.route, null);
});

test("an orb just past the edge is a warning, and the route walks to the clamped point and still wins", async () => {
  const project = patched(ORB_RUN_ENTITY.orbA, "Transform", { position: [5.9, 0.5, -4] });
  const report = analyzeOrbRunLevel(project);
  assert.equal(report.ok, true);
  assert.deepEqual(codes(report), ["orb_outside_arena"]);
  assert.ok(report.route?.waypoints.some((point) => point.x === 5.5), "the waypoint is clamped into the arena");
  assert.ok(report.route?.waypoints.every((point) => Math.abs(point.x) <= 5.5));
  const summary = await playRoute(project, report);
  assert.equal(summary.status, "won");
  assert.equal(summary.collectedCount, 3);
});

test("an exit outside the arena beyond its radius can never be reached", () => {
  const report = analyzeOrbRunLevel(patched(ORB_RUN_ENTITY.exit, "Transform", { position: [8, 0.05, 4] }));
  assert.deepEqual(codes(report), ["exit_unreachable"]);
  assert.equal(report.diagnostics[0]?.entityId, ORB_RUN_ENTITY.exit);
  assert.equal(report.ok, false);
});

test("a player starting outside the arena is a warning (it is clamped at the first move)", () => {
  const report = analyzeOrbRunLevel(patched(ORB_RUN_ENTITY.player, "Transform", { position: [-9, 0.5, -4] }));
  assert.equal(report.ok, true);
  assert.deepEqual(codes(report), ["player_outside_arena"]);
});

test("invalid rules are reported field by field instead of throwing", () => {
  const report = analyzeOrbRunLevel(withRules({ playerSpeed: 0, pickupRadius: -1 }));
  assert.equal(report.verdict, "invalid");
  assert.deepEqual(codes(report), ["rules_invalid", "rules_invalid"]);
  assert.deepEqual(
    report.diagnostics.map((entry) => entry.message.split(":")[0]).sort(),
    [`${ORB_RUN_RULES_COMPONENT}.pickupRadius`, `${ORB_RUN_RULES_COMPONENT}.playerSpeed`],
  );
  assert.equal(report.diagnostics[0]?.entityId, ORB_RUN_ENTITY.manager);
  assert.equal(report.rules, null);
});

test("a clock below the fastest conceivable run is `impossible`, and the bot indeed loses", async () => {
  const project = withRules({ timeLimitSeconds: 3 });
  const report = analyzeOrbRunLevel(project);
  assert.equal(report.verdict, "impossible");
  assert.equal(report.ok, false);
  assert.deepEqual(codes(report), ["time_impossible"]);
  assert.equal(report.diagnostics[0]?.entityId, ORB_RUN_ENTITY.manager);
  assert.ok(report.route, "the route is still reported so an agent can see how far off it is");
  const summary = await playRoute(project, report);
  assert.equal(summary.status, "lost");
});

test("between the bounds the level is `unproven`: a warning, no claim either way", async () => {
  const lower = analyzeOrbRunLevel(createOrbRunProject()).lowerBoundSeconds!;
  const playtest = analyzeOrbRunLevel(createOrbRunProject()).playtestSeconds!;
  const limit = (lower + playtest) / 2;
  const report = analyzeOrbRunLevel(withRules({ timeLimitSeconds: limit }));
  assert.equal(report.verdict, "unproven");
  assert.equal(report.ok, true, "a warning does not fail the check");
  assert.deepEqual(codes(report), ["time_unproven"]);
  assert.ok(report.slackSeconds! < 0);
});

test("a winnable level that uses most of the clock is `tight`, and the bot still wins", async () => {
  const base = analyzeOrbRunLevel(createOrbRunProject());
  const project = withRules({ timeLimitSeconds: Math.ceil((base.playtestSeconds! + 0.4) * 10) / 10 });
  const report = analyzeOrbRunLevel(project);
  assert.equal(report.verdict, "tight");
  assert.equal(report.ok, true);
  assert.deepEqual(codes(report), ["time_tight"]);
  const summary = await playRoute(project, report);
  assert.equal(summary.status, "won");
});

test("verdict sweep over speed x clock: `impossible` always loses, `tight`/`comfortable` always win, and more time never ranks worse", async () => {
  const rank: Record<OrbRunLevelVerdict, number> = { invalid: -1, impossible: 0, unproven: 1, tight: 2, comfortable: 3 };
  const speeds = [2.5, 3, 4, 5, 6, 8];
  const limits = [3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 30];
  const seen = new Set<OrbRunLevelVerdict>();
  for (const speed of speeds) {
    let previous = -2;
    for (const limit of limits) {
      const project = withRules({ playerSpeed: speed, timeLimitSeconds: limit });
      const report = analyzeOrbRunLevel(project);
      seen.add(report.verdict);
      assert.ok(rank[report.verdict] >= previous, `speed ${speed}: ${limit} s ranks ${report.verdict}, worse than a shorter clock`);
      previous = rank[report.verdict];
      const label = `speed ${speed} limit ${limit} (${report.verdict}, bot needs ${report.playtestSeconds}, floor ${report.lowerBoundSeconds})`;
      if (report.verdict === "impossible") {
        assert.equal((await playRoute(project, report)).status, "lost", label);
      } else if (report.verdict === "tight" || report.verdict === "comfortable") {
        const summary = await playRoute(project, report);
        assert.equal(summary.status, "won", label);
        assert.ok(summary.elapsedSeconds <= report.playtestSeconds! + 1e-9, label);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["comfortable", "impossible", "tight", "unproven"], "the sweep exercises every verdict");
});

test("structural problems: wrong scene, no orbs, two exits, two players, a Transform that is not finite numbers", () => {
  assert.deepEqual(codes(analyzeOrbRunLevel(createOrbRunProject(), { sceneId: "scene_nope" })), ["scene_missing"]);

  const noOrbs = cloneProject(createOrbRunProject());
  const scene = sceneOf(noOrbs);
  scene.entities = scene.entities.filter((entity) => !ORB_RUN_ORB_IDS.includes(entity.id as (typeof ORB_RUN_ORB_IDS)[number]));
  assert.deepEqual(codes(analyzeOrbRunLevel(noOrbs)), ["no_orbs"]);

  const duplicated = cloneProject(createOrbRunProject());
  const dupScene = sceneOf(duplicated);
  const exit = dupScene.entities.find((entity) => entity.id === ORB_RUN_ENTITY.exit)!;
  const player = dupScene.entities.find((entity) => entity.id === ORB_RUN_ENTITY.player)!;
  dupScene.entities.push({ ...structuredClone(exit), id: "entity_exit2" }, { ...structuredClone(player), id: "entity_player2", name: "Player2" });
  assert.deepEqual(codes(analyzeOrbRunLevel(duplicated)).sort(), ["exit_count", "player_count"]);

  const garbled = cloneProject(createOrbRunProject());
  const orb = sceneOf(garbled).entities.find((entity) => entity.id === ORB_RUN_ENTITY.orbB)!;
  (orb.components.Transform as { position: unknown }).position = [0, "high", 0];
  const report = analyzeOrbRunLevel(garbled);
  assert.deepEqual(codes(report), ["transform_invalid"]);
  assert.equal(report.diagnostics[0]?.entityId, ORB_RUN_ENTITY.orbB);

  const noManager = cloneProject(createOrbRunProject());
  const noManagerScene = sceneOf(noManager);
  noManagerScene.entities = noManagerScene.entities.filter((entity) => entity.id !== ORB_RUN_ENTITY.manager);
  assert.deepEqual(codes(analyzeOrbRunLevel(noManager)), ["manager_count"]);
});

test("two orbs on the same spot are a warning", () => {
  const report = analyzeOrbRunLevel(patched(ORB_RUN_ENTITY.orbC, "Transform", { position: [0, 0.5, 0] }));
  assert.equal(report.ok, true);
  assert.deepEqual(codes(report), ["orbs_duplicate_position"]);
});

test("past the exact-order limit the order is greedy and says so; the route is still a real, winnable route", async () => {
  const project = cloneProject(createOrbRunProject());
  const scene = sceneOf(project);
  const template = scene.entities.find((entity) => entity.id === ORB_RUN_ENTITY.orbA)!;
  const extra: EntityDefinition[] = [];
  for (let index = 0; index < ORB_RUN_LEVEL_EXACT_ORDER_LIMIT; index += 1) {
    const copy = structuredClone(template);
    copy.id = `entity_extra_orb_${index}`;
    copy.name = `Extra${index}`;
    (copy.components.Transform as { position: number[] }).position = [-5 + index * 1.3, 0.5, 2 - (index % 3)];
    extra.push(copy);
  }
  scene.entities.push(...extra);
  const manager = scene.entities.find((entity) => entity.id === ORB_RUN_ENTITY.manager)!;
  (manager.components[ORB_RUN_RULES_COMPONENT] as Record<string, number>).timeLimitSeconds = 120;

  const report = analyzeOrbRunLevel(project);
  assert.equal(report.orbCount, 3 + ORB_RUN_LEVEL_EXACT_ORDER_LIMIT);
  assert.equal(report.orderExact, false);
  assert.equal(new Set(report.route?.orbIds).size, report.orbCount, "every orb is visited exactly once");
  assert.equal(report.ok, true);
  assert.equal((await playRoute(project, report)).status, "won");
});

test("the analysis is deterministic and never mutates the project it reads", () => {
  const project = createOrbRunProject();
  const before = JSON.stringify(project);
  const first = analyzeOrbRunLevel(project);
  const second = analyzeOrbRunLevel(project);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(project), before);
});

test("the headless probe exposes the level check, and an acceptance manifest can gate on it", async () => {
  const manifest = (suite: string, expectedVerdict: string, expectedOk: boolean) =>
    acceptanceManifestSchema.parse({
      schemaVersion: 1,
      suite,
      steps: [
        { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
        { type: "assert.equal", path: "state.level.verdict", expected: expectedVerdict },
        { type: "assert.equal", path: "state.level.ok", expected: expectedOk },
      ],
    });

  const good = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(manifest("level.good", "comfortable", true));
  assert.equal(good.passed, true);

  // The same manifest fails on a level an agent broke through the command bus.
  const broken = new OrbRunHeadlessProbe({ project: withRules({ timeLimitSeconds: 3 }) });
  const failed = await new AcceptanceRunner(broken).run(manifest("level.good", "comfortable", true));
  assert.equal(failed.passed, false);
  const passedOnBroken = await new AcceptanceRunner(new OrbRunHeadlessProbe({ project: withRules({ timeLimitSeconds: 3 }) })).run(
    manifest("level.broken", "impossible", false),
  );
  assert.equal(passedOnBroken.passed, true);

  const probe = new OrbRunHeadlessProbe({ project: patched(ORB_RUN_ENTITY.orbA, "Transform", { position: [9, 0.5, -4] }) });
  await probe.start(ORB_RUN_SCENE_ID, 0);
  try {
    const level = (await probe.snapshot()).state.level as OrbRunLevelReport;
    assert.equal(level.verdict, "invalid");
    assert.equal(level.errorCount, 1);
    assert.equal(level.diagnostics[0]?.code, "orb_unreachable");
  } finally {
    await probe.stop();
  }
});
