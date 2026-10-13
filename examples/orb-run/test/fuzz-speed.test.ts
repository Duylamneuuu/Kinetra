import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_ACTION,
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_INVARIANTS,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  ORB_RUN_WINNING_ROUTE,
  OrbRunInvariantMonitor,
  createOrbRunProject,
  orbRunSlowZoneComponents,
  slowZoneMultiplierAt,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type OrbRunSlowZone,
} from "../src/index.js";

const PLAYER_SPEED = ORB_RUN_DEFAULT_RULES.playerSpeed;

function describe(violations: ReadonlyArray<{ step: number; invariant: string; message: string }>): string {
  return violations.map((violation) => `${violation.step} ${violation.invariant}: ${violation.message}`).join("\n");
}

function withMud(): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  const result = bus.execute({
    requestId: "mud",
    command: "entity.create",
    expectedProjectRevision: bus.revision,
    payload: {
      sceneId: ORB_RUN_SCENE_ID,
      entity: {
        id: "mud-start",
        name: "Mud",
        components: orbRunSlowZoneComponents({ x: -4, z: -4 }, { radius: 3, speedMultiplier: 0.4 }) as ComponentMap,
      },
    },
  });
  assert.equal(result.ok, true);
  return bus.snapshot().project;
}

test("player_speed_bound is a documented invariant", () => {
  assert.ok((ORB_RUN_INVARIANTS as readonly string[]).includes("player_speed_bound"));
  assert.equal(new Set(ORB_RUN_INVARIANTS).size, ORB_RUN_INVARIANTS.length);
});

test("a game that follows its rules never trips the speed bound, on open ground or in the mud", async () => {
  for (const [name, project] of [
    ["open", createOrbRunProject()],
    ["muddy", withMud()],
  ] as const) {
    const simulation = await startOrbRunSimulation(project);
    try {
      const monitor = new OrbRunInvariantMonitor(simulation);
      for (const target of ORB_RUN_WINNING_ROUTE) {
        walkTo(simulation, target, { stopWhen: () => summarizeOrbRun(simulation).status !== "playing" });
      }
      simulation.advance(5);
      assert.equal(summarizeOrbRun(simulation).status, "won", name);
      assert.ok(monitor.checked > 100, `${name}: only ${monitor.checked} steps checked`);
      assert.equal(monitor.ok, true, `${name}\n${describe(monitor.violations)}`);
    } finally {
      await simulation.dispose();
    }
  }
});

test("a rebalanced playerSpeed moves the ceiling with it (the bound reads the authored rules)", async () => {
  const bus = new CommandBus(createOrbRunProject());
  const patched = bus.execute({
    requestId: "faster",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { playerSpeed: 9 } as never },
  });
  assert.equal(patched.ok, true);
  const simulation = await startOrbRunSimulation(bus.snapshot().project);
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(20);
    const moved = summarizeOrbRun(simulation).player[0] - -4;
    assert.ok(Math.abs(moved - (9 * 20) / 30) < 1e-9, `moved ${moved} m`);
    assert.equal(monitor.ok, true, describe(monitor.violations));
  } finally {
    await simulation.dispose();
  }
});

test("the monitor catches a game that ignores its mud: exactly the steps that start inside the patch", async () => {
  // The simulation has no mud, but the level the monitor is told to expect has a 1 m patch round the start.
  const expectedZone: OrbRunSlowZone = { entityId: "intended-mud", x: -4, z: -4, radius: 1, speedMultiplier: 0.4 };
  const simulation = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(simulation, { slowZones: [expectedZone] });
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    let startedInside = 0;
    for (let index = 0; index < 40; index += 1) {
      const before = summarizeOrbRun(simulation).player;
      if (slowZoneMultiplierAt([expectedZone], before[0], before[2]) < 1) startedInside += 1;
      simulation.advance(1);
    }
    const speedViolations = monitor.violations.filter((violation) => violation.invariant === "player_speed_bound");
    assert.ok(startedInside > 5, `${startedInside} steps started in the patch`);
    assert.equal(speedViolations.length, startedInside, describe(monitor.violations));
    assert.equal(speedViolations[0]!.step, 1, "the very first step starts in the patch");
    assert.match(speedViolations[0]!.message, /at most 0\.05333.* allowed \(4 m\/s x 0\.4\)/);
    assert.equal(
      monitor.violations.every((violation) => violation.invariant === "player_speed_bound"),
      true,
      "nothing else is reported",
    );
  } finally {
    await simulation.dispose();
  }
});

test("a teleport is not a speed violation, and the step after it is judged from the new spot", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const monitor = new OrbRunInvariantMonitor(simulation);
    simulation.advance(2);
    simulation.restorePosition(ORB_RUN_ENTITY.player, [3, 0, 3]);
    simulation.advance(1);
    assert.equal(monitor.ok, true, describe(monitor.violations));
    simulation.setAction(ORB_RUN_ACTION.moveLeft, 1);
    simulation.advance(10);
    assert.equal(monitor.ok, true, describe(monitor.violations));
    assert.ok(Math.abs(summarizeOrbRun(simulation).player[0] - (3 - (PLAYER_SPEED * 10) / 30)) < 1e-9);

    // A second teleport mid-walk is skipped the same way: the monitor only judges steps nothing else touched.
    simulation.restorePosition(ORB_RUN_ENTITY.player, [-2, 0, 3]);
    simulation.advance(1);
    assert.equal(monitor.ok, true, describe(monitor.violations));
  } finally {
    await simulation.dispose();
  }
});

test("an expected zone with a multiplier of exactly 1 allows full speed, and finished runs stand still", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const zone: OrbRunSlowZone = { entityId: "free", x: -4, z: -4, radius: 20, speedMultiplier: 1 };
    const monitor = new OrbRunInvariantMonitor(simulation, { slowZones: [zone] });
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(700); // past the 20 s clock: the run is lost and frozen, the held key changes nothing
    assert.equal(summarizeOrbRun(simulation).status, "lost");
    assert.equal(monitor.ok, true, describe(monitor.violations));
  } finally {
    await simulation.dispose();
  }
});
