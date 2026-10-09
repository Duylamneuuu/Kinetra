import assert from "node:assert/strict";
import test from "node:test";

import { FakeGamepadSnapshotProvider, InputRouter, type PhysicalInputSnapshot } from "@kinetra/input";

import {
  ORB_RUN_ACTION,
  ORB_RUN_ENTITY,
  ORB_RUN_WINNING_ROUTE,
  captureOrbRunSave,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  walkTo,
  type HeadlessSceneSimulation,
} from "../src/index.js";

/**
 * P6 game-loop gate (#92), the deterministic half: the same Orb Run playthrough
 * driven by keyboard snapshots, by gamepad snapshots, and by a save → restart →
 * restore → finish sequence must land on the identical outcome. Input goes through
 * the real `InputRouter` and the default player input map, so a broken binding or
 * deadzone shows up here as a different run, not as a silent mismatch.
 */

type ActionId = (typeof ORB_RUN_ACTION)[keyof typeof ORB_RUN_ACTION];
const ACTION_IDS: readonly ActionId[] = Object.values(ORB_RUN_ACTION);

/** One simulation step's worth of held semantic actions. */
type Frame = readonly ActionId[];

/** Runs the playtest bot over the winning route and records which actions it held each step. */
async function recordWinningFrames(): Promise<{ frames: Frame[]; outcome: ReturnType<typeof outcomeOf> }> {
  const simulation = await startOrbRunSimulation();
  try {
    const frames: ActionId[][] = [];
    const held = new Set<ActionId>();
    const setAction = simulation.setAction.bind(simulation);
    const releaseAll = simulation.releaseAllActions.bind(simulation);
    const advance = simulation.advance.bind(simulation);
    simulation.setAction = (actionId, value) => {
      if (value > 0) held.add(actionId as ActionId);
      else held.delete(actionId as ActionId);
      setAction(actionId, value);
    };
    simulation.releaseAllActions = () => {
      held.clear();
      releaseAll();
    };
    simulation.advance = (steps = 1) => {
      for (let index = 0; index < steps; index += 1) frames.push([...held]);
      advance(steps);
    };
    const finished = () => summarizeOrbRun(simulation).status !== "playing";
    for (const target of ORB_RUN_WINNING_ROUTE) {
      walkTo(simulation, target, { stopWhen: finished });
      if (finished()) break;
    }
    if (!finished()) simulation.advance(1);
    return { frames, outcome: outcomeOf(simulation) };
  } finally {
    await simulation.dispose();
  }
}

function outcomeOf(simulation: HeadlessSceneSimulation) {
  return { summary: summarizeOrbRun(simulation), events: simulation.events(), logs: simulation.logs() };
}

/** Feeds one frame through the router and steps the simulation, like the player's fixed-step loop. */
function stepWithInput(simulation: HeadlessSceneSimulation, router: InputRouter, snapshot: PhysicalInputSnapshot): void {
  for (const actionId of ACTION_IDS) {
    simulation.setAction(actionId, Math.max(0, router.getActionValue(actionId, snapshot)));
  }
  simulation.advance(1);
  router.endStep();
}

type SnapshotBuilder = (frame: Frame) => PhysicalInputSnapshot;

function snapshot(keys: string[] = [], buttons: number[] = [], axes: number[] = []): PhysicalInputSnapshot {
  const gamepadButtons: number[] = [];
  for (const button of buttons) gamepadButtons[button] = 1;
  return { keys: new Set(keys), gamepadButtons, gamepadAxes: axes };
}

const has = (frame: Frame, id: ActionId): boolean => frame.includes(id);

const arrowKeys: SnapshotBuilder = (frame) =>
  snapshot([
    ...(has(frame, ORB_RUN_ACTION.moveRight) ? ["ArrowRight"] : []),
    ...(has(frame, ORB_RUN_ACTION.moveLeft) ? ["ArrowLeft"] : []),
    ...(has(frame, ORB_RUN_ACTION.moveForward) ? ["ArrowUp"] : []),
    ...(has(frame, ORB_RUN_ACTION.moveBackward) ? ["ArrowDown"] : []),
  ]);

const wasdKeys: SnapshotBuilder = (frame) =>
  snapshot([
    ...(has(frame, ORB_RUN_ACTION.moveRight) ? ["KeyD"] : []),
    ...(has(frame, ORB_RUN_ACTION.moveLeft) ? ["KeyA"] : []),
    ...(has(frame, ORB_RUN_ACTION.moveForward) ? ["KeyW"] : []),
    ...(has(frame, ORB_RUN_ACTION.moveBackward) ? ["KeyS"] : []),
  ]);

const dpad: SnapshotBuilder = (frame) =>
  snapshot(
    [],
    [
      ...(has(frame, ORB_RUN_ACTION.moveRight) ? [15] : []),
      ...(has(frame, ORB_RUN_ACTION.moveLeft) ? [14] : []),
      ...(has(frame, ORB_RUN_ACTION.moveForward) ? [12] : []),
      ...(has(frame, ORB_RUN_ACTION.moveBackward) ? [13] : []),
    ],
  );

function stick(tilt: number): SnapshotBuilder {
  return (frame) => {
    const x = (has(frame, ORB_RUN_ACTION.moveRight) ? tilt : 0) - (has(frame, ORB_RUN_ACTION.moveLeft) ? tilt : 0);
    const y = (has(frame, ORB_RUN_ACTION.moveBackward) ? tilt : 0) - (has(frame, ORB_RUN_ACTION.moveForward) ? tilt : 0);
    return snapshot([], [], [x, y]);
  };
}

/** Keyboard and gamepad held at once: the router sums and clamps, the run must not change. */
const keyboardAndPad: SnapshotBuilder = (frame) => {
  const keys = arrowKeys(frame);
  const pad = stick(1)(frame);
  return { keys: keys.keys, gamepadButtons: dpad(frame).gamepadButtons, gamepadAxes: pad.gamepadAxes };
};

async function playFrames(
  frames: readonly Frame[],
  build: SnapshotBuilder,
  simulation: HeadlessSceneSimulation,
  router = new InputRouter(),
): Promise<void> {
  for (const frame of frames) stepWithInput(simulation, router, build(frame));
}

const SCHEMES: ReadonlyArray<readonly [string, SnapshotBuilder]> = [
  ["keyboard arrows", arrowKeys],
  ["keyboard WASD", wasdKeys],
  ["gamepad d-pad", dpad],
  ["gamepad left stick, full tilt", stick(1)],
  ["gamepad left stick, partial tilt", stick(0.6)],
  ["keyboard + d-pad + stick together", keyboardAndPad],
];

test("the recorded bot run is a real win to replay", async () => {
  const { frames, outcome } = await recordWinningFrames();
  assert.equal(outcome.summary.status, "won");
  assert.equal(outcome.summary.collectedCount, 3);
  assert.equal(frames.length, outcome.summary.step);
  assert.ok(frames.some((frame) => frame.length > 0));
});

for (const [name, build] of SCHEMES) {
  test(`${name} replays the winning run with an identical outcome`, async () => {
    const { frames, outcome: expected } = await recordWinningFrames();
    const simulation = await startOrbRunSimulation();
    try {
      await playFrames(frames, build, simulation);
      assert.deepEqual(outcomeOf(simulation), expected);
    } finally {
      await simulation.dispose();
    }
  });
}

test("a stick inside the deadzone or reporting NaN does not move the player", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const router = new InputRouter();
    const before = summarizeOrbRun(simulation).player;
    for (let index = 0; index < 30; index += 1) {
      stepWithInput(simulation, router, snapshot([], [], [0.1, -0.1]));
      stepWithInput(simulation, router, snapshot([], [], [Number.NaN, Number.POSITIVE_INFINITY]));
      stepWithInput(simulation, router, snapshot([], [], []));
    }
    const after = summarizeOrbRun(simulation);
    assert.deepEqual(after.player, before);
    assert.equal(after.status, "playing");
    assert.equal(after.collectedCount, 0);
  } finally {
    await simulation.dispose();
  }
});

test("a pad that disconnects mid-run (no snapshot) releases every held action", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const router = new InputRouter();
    const provider = new FakeGamepadSnapshotProvider();
    const read = (): PhysicalInputSnapshot => {
      const pad = provider.getSnapshot();
      return { keys: new Set(), gamepadButtons: pad?.buttons ?? [], gamepadAxes: pad?.axes ?? [] };
    };
    provider.setSnapshot({ buttons: [], axes: [1, 0] });
    for (let index = 0; index < 10; index += 1) stepWithInput(simulation, router, read());
    const moved = summarizeOrbRun(simulation).player;
    assert.ok(moved[0] > -4, "the stick moved the player right");

    provider.setSnapshot(undefined);
    for (let index = 0; index < 10; index += 1) stepWithInput(simulation, router, read());
    assert.deepEqual(summarizeOrbRun(simulation).player, moved);
  } finally {
    await simulation.dispose();
  }
});

for (const [name, build] of [
  ["keyboard", arrowKeys],
  ["gamepad stick", stick(1)],
] as const) {
  test(`${name}: save mid-run, restart into a fresh simulation and router, finish with the same outcome`, async () => {
    const { frames, outcome: expected } = await recordWinningFrames();

    // Split after the second orb is taken but before the run is decided.
    const probe = await startOrbRunSimulation();
    let split = -1;
    try {
      const router = new InputRouter();
      for (const [index, frame] of frames.entries()) {
        stepWithInput(probe, router, build(frame));
        const summary = summarizeOrbRun(probe);
        if (summary.collectedCount === 2 && summary.status === "playing") {
          split = index + 1;
          break;
        }
      }
    } finally {
      await probe.dispose();
    }
    assert.ok(split > 0 && split < frames.length, "found a mid-run split point");

    const first = await startOrbRunSimulation();
    let save: ReturnType<typeof captureOrbRunSave>;
    try {
      await playFrames(frames.slice(0, split), build, first);
      save = JSON.parse(JSON.stringify(captureOrbRunSave(first))) as typeof save;
      assert.equal(summarizeOrbRun(first).collectedCount, 2);
    } finally {
      await first.dispose();
    }

    const second = await startOrbRunSimulation();
    try {
      second.restoreStep(save.step);
      await restoreOrbRunSave(second, save);
      const resumed = summarizeOrbRun(second);
      assert.equal(resumed.status, "playing");
      assert.equal(resumed.collectedCount, 2);
      assert.equal(resumed.step, split);

      await playFrames(frames.slice(split), build, second, new InputRouter());
      const finished = summarizeOrbRun(second);
      assert.deepEqual(finished, expected.summary);
      // Events and logs before the save belong to the first process; only the tail is replayed.
      assert.ok(second.events("orbRun.won").length === 1);
      assert.equal(second.logs().filter((entry) => entry.level === "warning" || entry.level === "error").length, 0);
    } finally {
      await second.dispose();
    }
  });
}

test("holding a direction across the restart does not leak into the restored run", async () => {
  const first = await startOrbRunSimulation();
  let save: ReturnType<typeof captureOrbRunSave>;
  try {
    const router = new InputRouter();
    for (let index = 0; index < 12; index += 1) stepWithInput(first, router, snapshot(["ArrowRight"]));
    save = JSON.parse(JSON.stringify(captureOrbRunSave(first))) as typeof save;
  } finally {
    await first.dispose();
  }

  const second = await startOrbRunSimulation();
  try {
    second.restoreStep(save.step);
    await restoreOrbRunSave(second, save);
    const resumedAt = summarizeOrbRun(second).player;
    assert.deepEqual(resumedAt, save.positions[ORB_RUN_ENTITY.player]);
    assert.ok(resumedAt[0] > -4, "the saved player had moved right before the restart");
    // No keys pressed after the restart: the player stays exactly where the save put it.
    const router = new InputRouter();
    for (let index = 0; index < 20; index += 1) stepWithInput(second, router, snapshot());
    assert.deepEqual(summarizeOrbRun(second).player, resumedAt);
  } finally {
    await second.dispose();
  }
});
