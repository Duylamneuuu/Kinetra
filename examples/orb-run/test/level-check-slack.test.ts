import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_ORB_IDS,
  ORB_RUN_RULES_COMPONENT,
  analyzeOrbRunLevel,
  createOrbRunProject,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkStraightTo,
  type OrbRunLevelReport,
  type OrbRunSummary,
} from "../src/index.js";

/**
 * Slice 38: the boundary of the level check's time claim. `slackSeconds = timeLimit - playtestSeconds` is only worth
 * something if the sign of the slack predicts what the bot really does. On seeded levels with the player, the three
 * orbs and the exit scattered over the arena (through `component.patch` on the command bus) this checks, around the
 * edge of the claim:
 * - the bot's real winning time sits between `lowerBoundSeconds` and `playtestSeconds`;
 * - a clock set to the predicted bot time (slack 0) is still won; one a few steps shorter than the *real* bot time loses;
 * - a clock at or under the lower bound is `impossible` and no input can win it (the bot loses it).
 */

const LEVELS = 40;
const STEP = 1 / 30;

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

interface Layout {
  player: [number, number];
  orbs: Array<[number, number]>;
  exit: [number, number];
  playerSpeed: number;
}

function layoutFor(seed: number): Layout {
  const random = mulberry32(seed * 104729 + 7);
  const spot = (): [number, number] => [Math.round((random() * 2 - 1) * 5 * 4) / 4, Math.round((random() * 2 - 1) * 5 * 4) / 4];
  return {
    player: spot(),
    orbs: ORB_RUN_ORB_IDS.map(() => spot()),
    exit: spot(),
    playerSpeed: [3, 4, 5, 6][Math.floor(random() * 4)]!,
  };
}

function buildLevel(layout: Layout, timeLimitSeconds: number): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  const patch = (entityId: string, component: string, value: Record<string, unknown>) => {
    const result = bus.execute({
      requestId: `slack-${entityId}-${component}`,
      command: "component.patch",
      payload: { entityId, component, patch: value as never },
    });
    assert.equal(result.ok, true, `patching ${entityId}.${component} failed: ${JSON.stringify(result)}`);
  };
  patch(ORB_RUN_ENTITY.player, "Transform", { position: [layout.player[0], 0.5, layout.player[1]] });
  ORB_RUN_ORB_IDS.forEach((id, index) => {
    const [x, z] = layout.orbs[index]!;
    patch(id, "Transform", { position: [x, 0.5, z] });
  });
  patch(ORB_RUN_ENTITY.exit, "Transform", { position: [layout.exit[0], 0.05, layout.exit[1]] });
  patch(ORB_RUN_ENTITY.manager, ORB_RUN_RULES_COMPONENT, { timeLimitSeconds, playerSpeed: layout.playerSpeed });
  return bus.snapshot().project;
}

/** Plays the analysed route with the eight-direction bot, then lets a stalled run run out its clock. */
async function playRoute(project: ProjectDocument, report: OrbRunLevelReport): Promise<OrbRunSummary> {
  const simulation = await startOrbRunSimulation(project);
  try {
    const rules = report.rules!;
    const finished = () => summarizeOrbRun(simulation).status !== "playing";
    for (const waypoint of report.route!.waypoints) {
      if (finished()) break;
      walkStraightTo(simulation, waypoint, { stopWhen: finished, playerSpeed: rules.playerSpeed, maxSteps: 4000 });
    }
    const budget = Math.ceil(rules.timeLimitSeconds / simulation.fixedDeltaSeconds) + 2;
    for (let used = 0; used < budget && !finished(); used += 1) simulation.advance(1);
    return summarizeOrbRun(simulation);
  } finally {
    await simulation.dispose();
  }
}

/** A clock long enough that the layout is always `comfortable`/`tight`, used to measure the bot's real time. */
const GENEROUS_CLOCK = 120;

test("slack tracks the bot: slack 0 still wins, a clock shorter than the real run loses", async () => {
  let checked = 0;
  for (let seed = 1; seed <= LEVELS; seed += 1) {
    const layout = layoutFor(seed);
    const label = `seed ${seed}`;

    // 1. Measure on a generous clock.
    const generous = buildLevel(layout, GENEROUS_CLOCK);
    const base = analyzeOrbRunLevel(generous);
    assert.equal(base.ok, true, `${label}: ${JSON.stringify(base.diagnostics)}`);
    assert.notEqual(base.route, null, label);
    const measured = await playRoute(generous, base);
    assert.equal(measured.status, "won", `${label}: ${JSON.stringify(measured)}`);
    assert.equal(measured.collectedCount, 3, label);
    const real = measured.elapsedSeconds;
    assert.ok(real <= base.playtestSeconds! + 1e-9, `${label}: the bot took ${real}s, more than the predicted ${base.playtestSeconds}s`);
    assert.ok(real >= base.lowerBoundSeconds! - 1e-9, `${label}: the bot took ${real}s, less than the lower bound ${base.lowerBoundSeconds}s`);

    // 2. A clock equal to the prediction (slack ~ 0, rounded up to the next microsecond) is still won.
    const edgeLimit = Math.ceil(base.playtestSeconds! * 1e6) / 1e6;
    const atEdge = buildLevel(layout, edgeLimit);
    const edgeReport = analyzeOrbRunLevel(atEdge);
    assert.ok(Math.abs(edgeReport.slackSeconds!) <= 2e-6, `${label}: slack ${edgeReport.slackSeconds} should be ~0`);
    assert.notEqual(edgeReport.verdict, "impossible", label);
    assert.notEqual(edgeReport.verdict, "invalid", label);
    const edge = await playRoute(atEdge, edgeReport);
    assert.equal(edge.status, "won", `${label}: slack ${edgeReport.slackSeconds}s but the bot ${JSON.stringify(edge)}`);

    // 3. A clock three steps shorter than the real run is lost, and the check says the bot cannot make it.
    const shortLimit = real - 3 * STEP;
    if (shortLimit > base.lowerBoundSeconds!) {
      const tooShort = buildLevel(layout, shortLimit);
      const shortReport = analyzeOrbRunLevel(tooShort);
      const lost = await playRoute(tooShort, shortReport);
      assert.equal(lost.status, "lost", `${label}: a ${shortLimit}s clock against a ${real}s run must lose, got ${JSON.stringify(lost)}`);
      assert.ok(lost.collectedCount < 3 || !lost.exitUnlocked || lost.remainingSeconds <= 0, label);
      // The check never promised this clock: either its slack is negative, or it makes no comfortable claim.
      assert.ok(shortReport.slackSeconds === null || shortReport.slackSeconds < 0.5, `${label}: slack ${shortReport.slackSeconds} on a clock the bot loses`);
      assert.notEqual(shortReport.verdict, "comfortable", label);
    }
    checked += 1;
  }
  assert.equal(checked, LEVELS);
});

test("a clock at or under the lower bound is impossible, and the bot loses it", async () => {
  for (let seed = 1; seed <= LEVELS; seed += 1) {
    const layout = layoutFor(seed);
    const label = `seed ${seed}`;
    const base = analyzeOrbRunLevel(buildLevel(layout, GENEROUS_CLOCK));
    // The report rounds to 6 decimals, so aim a hair under the bound ("at or under"); the rules want a clock of at least a second.
    const limit = Math.round((base.lowerBoundSeconds! - 1e-5) * 1e6) / 1e6;
    if (limit < 1) continue;
    const project = buildLevel(layout, limit);
    const report = analyzeOrbRunLevel(project);
    assert.equal(report.verdict, "impossible", `${label}: clock ${limit} vs lower bound ${base.lowerBoundSeconds}`);
    assert.equal(report.ok, false, label);
    assert.ok(report.diagnostics.some((entry) => entry.code === "time_impossible"), label);

    // Even the bot following the generous route (the best any input could do) cannot beat it.
    const summary = await playRoute(project, { ...base, rules: report.rules });
    assert.equal(summary.status, "lost", `${label}: ${JSON.stringify(summary)}`);
  }
});

test("slack is exactly the clock minus the prediction, and the verdict follows its sign", () => {
  for (let seed = 1; seed <= LEVELS; seed += 1) {
    const layout = layoutFor(seed);
    const base = analyzeOrbRunLevel(buildLevel(layout, GENEROUS_CLOCK));
    for (const delta of [-2, -0.5, -STEP, 0, STEP, 0.5, 2]) {
      const limit = Math.round((base.playtestSeconds! + delta) * 1e6) / 1e6;
      if (limit < 1) continue;
      const report = analyzeOrbRunLevel(buildLevel(layout, limit));
      const label = `seed ${seed} delta ${delta}`;
      if (report.verdict === "impossible") {
        assert.ok(report.lowerBoundSeconds! >= limit - 1e-6, `${label}: impossible but the lower bound ${report.lowerBoundSeconds} < clock ${limit}`);
        continue;
      }
      assert.ok(Math.abs(report.slackSeconds! - (limit - base.playtestSeconds!)) < 2e-6, `${label}: slack ${report.slackSeconds}`);
      // The report rounds playtest and slack to 6 decimals: at slack ~0 either side of the edge is legitimate.
      if (Math.abs(report.slackSeconds!) < 1e-5) assert.notEqual(report.verdict, "impossible", label);
      else if (report.slackSeconds! < 0) assert.equal(report.verdict, "unproven", label);
      else assert.ok(report.verdict === "tight" || report.verdict === "comfortable", `${label}: ${report.verdict} with slack ${report.slackSeconds}`);
    }
  }
});
