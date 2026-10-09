import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";

import {
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_HUD_CRITICAL_SECONDS,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_WINNING_ROUTE,
  buildOrbRunHud,
  captureOrbRunSave,
  compassFor,
  computeOrbRunHud,
  createOrbRunProject,
  formatClock,
  readOrbRunRules,
  renderOrbRunHudText,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type HudTimerUrgency,
  type HeadlessSceneSimulation,
  type OrbRunSummary,
} from "../src/index.js";

function summary(overrides: Partial<OrbRunSummary> = {}): OrbRunSummary {
  return {
    status: "playing",
    collectedCount: 0,
    totalOrbs: 3,
    exitUnlocked: false,
    elapsedSeconds: 0,
    remainingSeconds: 20,
    step: 0,
    player: [0, 0.5, 0],
    ...overrides,
  };
}

const finished = (simulation: HeadlessSceneSimulation) => () => summarizeOrbRun(simulation).status !== "playing";

function playRoute(simulation: HeadlessSceneSimulation): void {
  for (const target of ORB_RUN_WINNING_ROUTE) {
    walkTo(simulation, target, { stopWhen: finished(simulation) });
    if (finished(simulation)()) return;
  }
  simulation.advance(1);
}

test("formatClock renders m:ss and rejects non-finite or negative seconds", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(9), "0:09");
  assert.equal(formatClock(59), "0:59");
  assert.equal(formatClock(60), "1:00");
  assert.equal(formatClock(125), "2:05");
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => formatClock(bad), RangeError);
});

test("compassFor snaps a bearing to eight directions and wraps around", () => {
  const expected: Array<[number, string]> = [
    [0, "N"],
    [22, "N"],
    [23, "NE"],
    [90, "E"],
    [135, "SE"],
    [180, "S"],
    [225, "SW"],
    [270, "W"],
    [315, "NW"],
    [359, "N"],
    [-90, "W"],
    [450, "E"],
  ];
  for (const [bearing, compass] of expected) assert.equal(compassFor(bearing), compass, `${bearing} deg`);
});

test("timer urgency: normal, warning at half the limit, critical at 5 s, expired at 0", () => {
  const urgencyAt = (remainingSeconds: number): HudTimerUrgency =>
    computeOrbRunHud({ summary: summary({ remainingSeconds }), rules: ORB_RUN_DEFAULT_RULES }).timer.urgency;
  assert.equal(ORB_RUN_HUD_CRITICAL_SECONDS, 5);
  assert.equal(urgencyAt(20), "normal");
  assert.equal(urgencyAt(10.01), "normal");
  assert.equal(urgencyAt(10), "warning");
  assert.equal(urgencyAt(5.01), "warning");
  assert.equal(urgencyAt(5), "critical");
  assert.equal(urgencyAt(0.01), "critical");
  assert.equal(urgencyAt(0), "expired");
});

test("timer text rounds up so the clock never shows 0:00 while time is left, and absorbs float drift", () => {
  const timer = (remainingSeconds: number, limit = 60) =>
    computeOrbRunHud({
      summary: summary({ remainingSeconds }),
      rules: { ...ORB_RUN_DEFAULT_RULES, timeLimitSeconds: limit },
    }).timer;
  assert.equal(timer(0.01).text, "0:01");
  assert.equal(timer(0.01).displaySeconds, 1);
  assert.equal(timer(29.999999999999996).text, "0:30");
  assert.equal(timer(30.2).text, "0:31");
  assert.equal(timer(60).text, "1:00");
  assert.equal(timer(60).fraction, 1);
  assert.equal(timer(15).fraction, 0.25);
  assert.equal(timer(0).text, "0:00");
  assert.equal(timer(-3).remainingSeconds, 0, "a negative remainder is clamped");
  assert.equal(timer(500).fraction, 1, "fraction is clamped to 1");
});

test("a finished run keeps its timer calm: won is normal, lost is expired", () => {
  const won = computeOrbRunHud({
    summary: summary({ status: "won", collectedCount: 3, exitUnlocked: true, remainingSeconds: 2, elapsedSeconds: 18 }),
    rules: ORB_RUN_DEFAULT_RULES,
  });
  assert.equal(won.timer.urgency, "normal", "winning with 2 s left must not flash critical");
  const lost = computeOrbRunHud({
    summary: summary({ status: "lost", collectedCount: 1, remainingSeconds: 0, elapsedSeconds: 20 }),
    rules: ORB_RUN_DEFAULT_RULES,
  });
  assert.equal(lost.timer.urgency, "expired");
  assert.deepEqual(lost.banner, { kind: "lost", title: "Time's up", subtitle: "1/3 orbs collected" });
  assert.deepEqual(won.banner, { kind: "won", title: "You win!", subtitle: "3/3 orbs in 18.0 s" });
});

test("objective follows progress: collect, reach the exit, then the result", () => {
  const objective = (overrides: Partial<OrbRunSummary>) =>
    computeOrbRunHud({ summary: summary(overrides), rules: ORB_RUN_DEFAULT_RULES }).objective;
  assert.deepEqual(objective({}), { kind: "collectOrbs", text: "Collect the orbs (3 left)" });
  assert.deepEqual(objective({ collectedCount: 2 }), { kind: "collectOrbs", text: "Collect the orbs (1 left)" });
  assert.deepEqual(objective({ collectedCount: 3, exitUnlocked: true }), { kind: "reachExit", text: "Reach the exit" });
  assert.equal(objective({ status: "won", collectedCount: 3 }).kind, "won");
  assert.equal(objective({ status: "lost" }).kind, "lost");
});

test("marker points at the nearest uncollected orb, then the exit; ties break on entity id", () => {
  const rules = ORB_RUN_DEFAULT_RULES;
  const targets = [
    { kind: "orb", entityId: "b", position: [3, 0] },
    { kind: "orb", entityId: "a", position: [0, -3] },
    { kind: "orb", entityId: "far", position: [9, 9] },
    { kind: "exit", entityId: "exit", position: [0, 1] },
  ] as const;
  const marker = computeOrbRunHud({ summary: summary(), rules, targets }).marker;
  assert.equal(marker?.targetEntityId, "a", "equidistant orbs: the lower id wins");
  assert.equal(marker?.compass, "N", "-z is forward");
  assert.equal(marker?.bearingDegrees, 0);
  assert.equal(marker?.distance, 3);
  assert.equal(marker?.text, "Orb N 3.0 m");

  const toExit = computeOrbRunHud({
    summary: summary({ collectedCount: 3, exitUnlocked: true }),
    rules,
    targets,
  }).marker;
  assert.equal(toExit?.kind, "exit");
  assert.equal(toExit?.compass, "S");
  assert.equal(toExit?.text, "Exit S 1.0 m");

  assert.equal(computeOrbRunHud({ summary: summary(), rules }).marker, null, "no targets, no marker");
  assert.equal(
    computeOrbRunHud({ summary: summary(), rules, targets: [{ kind: "exit", entityId: "exit", position: [0, 1] }] })
      .marker,
    null,
    "while orbs remain the exit is not pointed at",
  );
  assert.equal(
    computeOrbRunHud({ summary: summary({ status: "won", collectedCount: 3 }), rules, targets }).marker,
    null,
    "a finished run has no marker",
  );
  const onTop = computeOrbRunHud({
    summary: summary({ player: [3, 0.5, 0] }),
    rules,
    targets: [{ kind: "orb", entityId: "b", position: [3, 0] }],
  }).marker;
  assert.equal(onTop?.distance, 0, "standing on the target is distance 0, not NaN");
  assert.equal(onTop?.bearingDegrees, 0);
});

test("the opening HUD of the authored game is exact", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const hud = buildOrbRunHud(simulation);
    assert.equal(hud.orbs.text, "Orbs 0/3");
    assert.equal(hud.orbs.remaining, 3);
    assert.equal(hud.orbs.complete, false);
    assert.equal(hud.timer.text, "0:20");
    assert.equal(hud.timer.fraction, 1);
    assert.equal(hud.timer.urgency, "normal");
    assert.equal(hud.exit.text, "Exit locked");
    assert.equal(hud.banner, null);
    // Player (-4, -4); nearest orb is OrbB at (0, 0): 4 m east and 4 m south => SE at 135 deg, 5.66 m.
    assert.equal(hud.marker?.targetEntityId, ORB_RUN_ENTITY.orbB);
    assert.equal(hud.marker?.compass, "SE");
    assert.equal(hud.marker?.bearingDegrees, 135);
    assert.equal(hud.marker?.distance, 5.66);
    assert.equal(renderOrbRunHudText(hud), "Orbs 0/3 | 0:20 | Exit locked | Orb SE 5.7 m");
  } finally {
    await simulation.dispose();
  }
});

test("the HUD tracks a winning run end to end and freezes with the result", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const seen: Array<{ orbs: string; marker: string | undefined; objective: string }> = [];
    let lastRemaining = Number.POSITIVE_INFINITY;
    for (const target of ORB_RUN_WINNING_ROUTE) {
      walkTo(simulation, target, { stopWhen: finished(simulation) });
      const hud = buildOrbRunHud(simulation);
      assert.ok(hud.timer.remainingSeconds <= lastRemaining, "the clock only counts down");
      lastRemaining = hud.timer.remainingSeconds;
      seen.push({ orbs: hud.orbs.text, marker: hud.marker?.kind, objective: hud.objective.kind });
      // The HUD must agree with the script state it is derived from.
      const state = summarizeOrbRun(simulation);
      assert.equal(hud.orbs.collected, state.collectedCount);
      assert.equal(hud.exit.unlocked, state.exitUnlocked);
    }
    simulation.advance(1);
    const won = buildOrbRunHud(simulation);

    // After each stop on the route: A collected, B collected, C collected (exit open), then the run is won.
    assert.deepEqual(
      seen.map((entry) => entry.orbs),
      ["Orbs 1/3", "Orbs 2/3", "Orbs 3/3", "Orbs 3/3"],
    );
    assert.deepEqual(
      seen.map((entry) => entry.objective),
      ["collectOrbs", "collectOrbs", "reachExit", "won"],
    );
    assert.equal(seen[2]?.marker, "exit", "once the last orb is in, the marker points at the exit");

    assert.equal(won.objective.kind, "won");
    assert.equal(won.banner?.kind, "won");
    assert.match(won.banner?.subtitle ?? "", /^3\/3 orbs in \d+\.\d s$/);
    assert.equal(won.marker, null);
    assert.equal(won.exit.text, "Exit open");
    assert.equal(won.timer.urgency, "normal");

    simulation.advance(600);
    assert.deepEqual(buildOrbRunHud(simulation), won, "a finished run's HUD no longer changes");
  } finally {
    await simulation.dispose();
  }
});

test("an idle run walks the timer through normal, warning, critical and expired, then shows the loss", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const sequence: HudTimerUrgency[] = [];
    const firstAt: Record<string, string> = {};
    for (let index = 0; index < 20 * 30 + 5; index += 1) {
      const hud = buildOrbRunHud(simulation);
      if (sequence.at(-1) !== hud.timer.urgency) {
        sequence.push(hud.timer.urgency);
        firstAt[hud.timer.urgency] = hud.timer.text;
      }
      simulation.advance(1);
    }
    assert.deepEqual(sequence, ["normal", "warning", "critical", "expired"]);
    assert.equal(firstAt.warning, "0:10", "warning starts at half of the 20 s clock");
    assert.equal(firstAt.critical, "0:05");
    const lost = buildOrbRunHud(simulation);
    assert.equal(lost.timer.text, "0:00");
    assert.equal(lost.timer.fraction, 0);
    assert.equal(lost.objective.kind, "lost");
    assert.deepEqual(lost.banner, { kind: "lost", title: "Time's up", subtitle: "0/3 orbs collected" });
    assert.equal(lost.marker, null);
  } finally {
    await simulation.dispose();
  }
});

test("a HUD restored from a save is identical to the HUD that was saved", async () => {
  const original = await startOrbRunSimulation();
  const restored = await startOrbRunSimulation();
  try {
    walkTo(original, ORB_RUN_WINNING_ROUTE[0]!);
    walkTo(original, ORB_RUN_WINNING_ROUTE[1]!);
    const save = JSON.parse(JSON.stringify(captureOrbRunSave(original))) as ReturnType<typeof captureOrbRunSave>;
    restored.restoreStep(save.step);
    await restoreOrbRunSave(restored, save);
    const before = buildOrbRunHud(original);
    assert.equal(before.orbs.text, "Orbs 2/3");
    assert.deepEqual(buildOrbRunHud(restored), before);
  } finally {
    await original.dispose();
    await restored.dispose();
  }
});

test("the HUD reads the authored rules: a 60 s clock patched through the command bus shows 1:00", async () => {
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "longer-clock",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { timeLimitSeconds: 60 } },
  });
  const simulation = await startOrbRunSimulation(bus.snapshot().project);
  try {
    assert.equal(readOrbRunRules(simulation).timeLimitSeconds, 60);
    const hud = buildOrbRunHud(simulation);
    assert.equal(hud.timer.text, "1:00");
    simulation.advance(15 * 30);
    const later = buildOrbRunHud(simulation);
    assert.equal(later.timer.text, "0:45");
    assert.equal(later.timer.fraction, 0.75);
  } finally {
    await simulation.dispose();
  }
});

test("the HUD model is plain JSON (a renderer or the acceptance probe can serialize it)", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    playRoute(simulation);
    const hud = buildOrbRunHud(simulation);
    assert.deepEqual(JSON.parse(JSON.stringify(hud)), hud);
  } finally {
    await simulation.dispose();
  }
});
