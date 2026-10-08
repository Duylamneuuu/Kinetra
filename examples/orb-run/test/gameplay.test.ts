import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";

import {
  ORB_RUN_ACTION,
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_EVENT,
  ORB_RUN_ORB_IDS,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  ORB_RUN_WINNING_ROUTE,
  OrbRunRulesError,
  captureOrbRunSave,
  createOrbRunProject,
  createOrbRunScriptRegistry,
  parseOrbRunRules,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type HeadlessSceneSimulation,
} from "../src/index.js";

function playRoute(
  simulation: HeadlessSceneSimulation,
  route = ORB_RUN_WINNING_ROUTE,
  options: { settle?: boolean } = {},
): void {
  const finished = () => summarizeOrbRun(simulation).status !== "playing";
  for (const target of route) {
    walkTo(simulation, target, { stopWhen: finished });
    if (finished()) return;
  }
  // One settle step so the manager evaluates the final position.
  if (options.settle !== false) simulation.advance(1);
}

test("scripts start cleanly with the authored rules and starting state", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    assert.deepEqual(simulation.unresolvedScripts, []);
    for (const state of simulation.scriptStates()) {
      assert.equal(state.lifecycleState, "started", `${state.scriptId} started`);
    }
    const started = simulation.logs("orbRun.started");
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.data, {
      totalOrbs: 3,
      timeLimitSeconds: ORB_RUN_DEFAULT_RULES.timeLimitSeconds,
      playerFound: true,
      exitFound: true,
    });
    const summary = summarizeOrbRun(simulation);
    assert.equal(summary.status, "playing");
    assert.equal(summary.collectedCount, 0);
    assert.equal(summary.exitUnlocked, false);
    assert.deepEqual(summary.player, [-4, 0.5, -4]);
  } finally {
    await simulation.dispose();
  }
});

test("playtest bot wins by collecting every orb then reaching the exit", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    playRoute(simulation);
    const summary = summarizeOrbRun(simulation);
    assert.equal(summary.status, "won");
    assert.equal(summary.collectedCount, 3);
    assert.equal(summary.exitUnlocked, true);
    assert.ok(summary.elapsedSeconds < ORB_RUN_DEFAULT_RULES.timeLimitSeconds);
    assert.ok(summary.remainingSeconds > 0);

    const collected = simulation.events(ORB_RUN_EVENT.orbCollected);
    assert.deepEqual(
      collected.map((event) => (event.payload as { orbId: string }).orbId),
      [ORB_RUN_ENTITY.orbA, ORB_RUN_ENTITY.orbB, ORB_RUN_ENTITY.orbC],
      "orbs are collected in route order, each exactly once",
    );
    const unlocked = simulation.events(ORB_RUN_EVENT.exitUnlocked);
    assert.equal(unlocked.length, 1);
    assert.ok(unlocked[0]!.step >= collected[2]!.step, "exit unlocks only after the last orb");
    assert.equal(simulation.events(ORB_RUN_EVENT.won).length, 1);
    assert.equal(simulation.events(ORB_RUN_EVENT.lost).length, 0);

    for (const orbId of ORB_RUN_ORB_IDS) {
      assert.equal(simulation.getPosition(orbId)?.[1], -10, "collected orbs are hidden below the floor");
      assert.equal(simulation.scriptState(orbId)?.state?.collected, true);
    }
    assert.deepEqual(simulation.logs().filter((entry) => entry.level === "error"), []);

    // The run is over: input no longer moves the player and the clock stops.
    const frozen = summarizeOrbRun(simulation);
    simulation.setAction(ORB_RUN_ACTION.moveLeft, 1);
    simulation.advance(30);
    const after = summarizeOrbRun(simulation);
    assert.deepEqual(after.player, frozen.player);
    assert.equal(after.elapsedSeconds, frozen.elapsedSeconds);
    assert.equal(after.status, "won");
  } finally {
    await simulation.dispose();
  }
});

test("reaching the exit before collecting every orb does not win", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    // Detour through the empty lane at z = -2 so no orb is ever within pickup range.
    walkTo(simulation, { x: -4, z: -2 });
    walkTo(simulation, { x: 4, z: -2 });
    walkTo(simulation, { x: 4, z: 4 });
    simulation.advance(5);
    const summary = summarizeOrbRun(simulation);
    assert.equal(summary.status, "playing");
    assert.equal(summary.exitUnlocked, false);
    assert.equal(summary.collectedCount, 0);
    assert.equal(simulation.events(ORB_RUN_EVENT.won).length, 0);
  } finally {
    await simulation.dispose();
  }
});

test("idling past the time limit loses exactly once", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const limitSteps = Math.ceil(ORB_RUN_DEFAULT_RULES.timeLimitSeconds / simulation.fixedDeltaSeconds);
    simulation.advance(limitSteps - 2);
    assert.equal(summarizeOrbRun(simulation).status, "playing");
    simulation.advance(4);
    const summary = summarizeOrbRun(simulation);
    assert.equal(summary.status, "lost");
    assert.equal(summary.remainingSeconds, 0);
    simulation.advance(30);
    assert.equal(simulation.events(ORB_RUN_EVENT.lost).length, 1);
  } finally {
    await simulation.dispose();
  }
});

test("the player is clamped to the arena", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    simulation.setAction(ORB_RUN_ACTION.moveLeft, 1);
    simulation.setAction(ORB_RUN_ACTION.moveForward, 1);
    simulation.advance(90);
    const [x, , z] = summarizeOrbRun(simulation).player;
    assert.equal(x, -ORB_RUN_DEFAULT_RULES.arenaHalfExtent);
    assert.equal(z, -ORB_RUN_DEFAULT_RULES.arenaHalfExtent);
  } finally {
    await simulation.dispose();
  }
});

test("same inputs give the same run (determinism)", async () => {
  const runs = [];
  for (let index = 0; index < 2; index += 1) {
    const simulation = await startOrbRunSimulation();
    playRoute(simulation);
    runs.push({ summary: summarizeOrbRun(simulation), events: simulation.events(), logs: simulation.logs() });
    await simulation.dispose();
  }
  assert.deepEqual(runs[0], runs[1]);
});

test("save mid-run, restore into a fresh simulation, and finish with the same outcome", async () => {
  const reference = await startOrbRunSimulation();
  playRoute(reference);
  const expected = summarizeOrbRun(reference);
  await reference.dispose();

  const first = await startOrbRunSimulation();
  playRoute(first, ORB_RUN_WINNING_ROUTE.slice(0, 2), { settle: false });
  const save = JSON.parse(JSON.stringify(captureOrbRunSave(first))) as ReturnType<typeof captureOrbRunSave>;
  assert.equal(summarizeOrbRun(first).collectedCount, 2);
  await first.dispose();

  const second = await startOrbRunSimulation();
  try {
    await restoreOrbRunSave(second, save);
    const resumed = summarizeOrbRun(second);
    assert.equal(resumed.collectedCount, 2);
    assert.equal(resumed.status, "playing");
    assert.equal(second.getPosition(ORB_RUN_ENTITY.orbA)?.[1], -10);
    assert.equal(second.getPosition(ORB_RUN_ENTITY.orbC)?.[1], 0.5);

    playRoute(second, ORB_RUN_WINNING_ROUTE.slice(2));
    const finished = summarizeOrbRun(second);
    assert.equal(finished.status, "won");
    assert.equal(finished.collectedCount, expected.collectedCount);
    assert.ok(Math.abs(finished.elapsedSeconds - expected.elapsedSeconds) < 1e-9);
    assert.deepEqual(finished.player, expected.player);
  } finally {
    await second.dispose();
  }
});

test("corrupt saves are rejected before any state changes", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    await assert.rejects(
      simulation.restoreScript(ORB_RUN_ENTITY.manager, {
        status: "playing",
        collectedOrbIds: ["entity_not_an_orb"],
        exitUnlocked: false,
        elapsedSeconds: 1,
      }),
      /unknown orb/,
    );
    await assert.rejects(
      simulation.restoreScript(ORB_RUN_ENTITY.manager, {
        status: "playing",
        collectedOrbIds: [ORB_RUN_ENTITY.orbA],
        exitUnlocked: true,
        elapsedSeconds: 1,
      }),
      /exitUnlocked requires every orb/,
    );
    await assert.rejects(simulation.restoreScript(ORB_RUN_ENTITY.orbA, { collected: "yes" }), /boolean/);
    assert.equal(summarizeOrbRun(simulation).collectedCount, 0);
    assert.equal(simulation.scriptState(ORB_RUN_ENTITY.orbA)?.state?.collected, false);
  } finally {
    await simulation.dispose();
  }
});

test("rules authored through the command bus change gameplay without code changes", async () => {
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "tighten-clock",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { timeLimitSeconds: 5 } },
  });
  const simulation = await startOrbRunSimulation(bus.snapshot().project);
  try {
    playRoute(simulation);
    const summary = summarizeOrbRun(simulation);
    assert.equal(summary.status, "lost", "the winning route needs ~8 s, so a 5 s clock loses");
    assert.ok(summary.collectedCount < 3);
  } finally {
    await simulation.dispose();
  }
});

test("invalid rules are reported with every issue", () => {
  assert.throws(
    () => parseOrbRunRules({ timeLimitSeconds: -1, pickupRadius: "far" }),
    (error: unknown) =>
      error instanceof OrbRunRulesError &&
      error.code === "ORB_RUN_RULES_INVALID" &&
      error.issues.map((issue) => issue.field).join(",") === "timeLimitSeconds,pickupRadius",
  );
  assert.throws(() => parseOrbRunRules(undefined), OrbRunRulesError);

  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "break-rules",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { playerSpeed: 0 } },
  });
  assert.throws(() => createOrbRunScriptRegistry(bus.snapshot().project, ORB_RUN_SCENE_ID), OrbRunRulesError);
});

test("an unregistered script is reported, not silently skipped", async () => {
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "typo",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.orbB, component: "Script", patch: { scriptId: "OrbRunOrbTypo" } },
  });
  const simulation = await startOrbRunSimulation(bus.snapshot().project);
  try {
    assert.deepEqual(simulation.unresolvedScripts, [{ entityId: ORB_RUN_ENTITY.orbB, scriptId: "OrbRunOrbTypo" }]);
    assert.equal(simulation.logs("script.resolveFailed").length, 1);
  } finally {
    await simulation.dispose();
  }
});
