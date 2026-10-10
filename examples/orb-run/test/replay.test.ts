import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";

import {
  ORB_RUN_ACTION,
  ORB_RUN_ENTITY,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  OrbRunHeadlessProbe,
  OrbRunReplayError,
  OrbRunReplayRecorder,
  createOrbRunProject,
  createOrbRunReplays,
  digestOrbRunState,
  parseOrbRunReplay,
  playOrbRunReplay,
  recordOrbRunReplay,
  startOrbRunSimulation,
  type OrbRunReplay,
} from "../src/index.js";

async function golden(name: "win" | "timeout"): Promise<OrbRunReplay> {
  // dist/test/*.js -> examples/orb-run/acceptance/replays/
  const url = new URL(`../../acceptance/replays/${name}.replay.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as OrbRunReplay;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("a recorded winning run replays to the same state, checkpoint by checkpoint", async () => {
  const { win } = await createOrbRunReplays();
  assert.equal(win.outcome.status, "won");
  assert.equal(win.outcome.collectedCount, 3);
  assert.equal(win.checkpoints.at(-1)?.step, win.totalSteps);
  assert.ok(win.inputs.length >= 4, "a route with four legs changes the held set several times");
  assert.ok(win.checkpoints.length > 3);

  const result = await playOrbRunReplay(win);
  assert.equal(result.verified, true);
  assert.equal(result.divergence, undefined);
  assert.deepEqual(result.outcomeMismatches, []);
  assert.equal(result.summary.status, "won");
  assert.equal(result.summary.step, win.totalSteps);
  assert.equal(result.finalDigest, win.checkpoints.at(-1)?.digest);
});

test("a replay survives a JSON round trip and recording is deterministic", async () => {
  const first = await createOrbRunReplays();
  const second = await createOrbRunReplays();
  assert.equal(JSON.stringify(first.win), JSON.stringify(second.win), "same input, byte-identical recording");
  assert.equal(JSON.stringify(first.timeout), JSON.stringify(second.timeout));
  const result = await playOrbRunReplay(JSON.parse(JSON.stringify(first.win)));
  assert.equal(result.verified, true);
});

test("an idle run records no input and replays to the loss", async () => {
  const { timeout } = await createOrbRunReplays();
  assert.deepEqual(timeout.inputs, []);
  assert.equal(timeout.outcome.status, "lost");
  assert.equal(timeout.outcome.collectedCount, 0);
  const result = await playOrbRunReplay(timeout);
  assert.equal(result.verified, true);
  assert.equal(result.summary.status, "lost");
});

test("the committed golden replays still reproduce (gameplay regression gate)", async () => {
  const generated = await createOrbRunReplays();
  for (const name of ["win", "timeout"] as const) {
    const committed = await golden(name);
    const result = await playOrbRunReplay(committed);
    assert.equal(
      result.verified,
      true,
      `${name}.replay.json diverged at step ${String(result.divergence?.step)}; if the gameplay change is intended run \`pnpm --filter @kinetra/example-orb-run snapshot\``,
    );
    // The file on disk is exactly what the recorder produces today (no hand edits, no stale digests).
    assert.deepEqual(committed, generated[name]);
  }
});

test("dropping an input is caught and located at the first checkpoint that sees it", async () => {
  const win = clone((await createOrbRunReplays()).win);
  const first = win.inputs[0];
  assert.ok(first);
  win.inputs.shift();
  const result = await playOrbRunReplay(win);
  assert.equal(result.verified, false);
  const every = win.checkpoints[0]!.step;
  assert.equal(result.divergence?.step, every, "the player never moved, so the very first checkpoint differs");
  assert.notEqual(result.divergence?.expected, result.divergence?.actual);
  assert.equal(result.summary.collectedCount < 3, true);
  assert.ok(result.outcomeMismatches.includes("status") || result.outcomeMismatches.includes("collectedCount"));
});

test("shifting one input by a single step changes the digest", async () => {
  const win = clone((await createOrbRunReplays()).win);
  const index = win.inputs.findIndex((input, i) => i > 0 && input.step + 1 < (win.inputs[i + 1]?.step ?? Infinity));
  assert.ok(index > 0);
  win.inputs[index]!.step += 1;
  const result = await playOrbRunReplay(win);
  assert.equal(result.verified, false);
  assert.ok(result.divergence);
  assert.ok(result.divergence.step >= win.inputs[index]!.step - 1);
});

test("rebalancing the game through the command bus breaks the old recording and says where", async () => {
  const { win } = await createOrbRunReplays();
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "slow-runner",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { playerSpeed: 2 } },
  });
  const result = await playOrbRunReplay(win, { project: bus.snapshot().project });
  assert.equal(result.verified, false);
  assert.ok(result.divergence && result.divergence.step <= win.checkpoints[0]!.step);
  assert.ok(result.outcomeMismatches.length > 0, "half speed does not finish the same run");
});

test("the replay is a pure function of its inputs: digests move every step and ignore the HUD/animation", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const seen = new Set<string>([digestOrbRunState(simulation)]);
    simulation.advance(1);
    seen.add(digestOrbRunState(simulation));
    simulation.advance(1);
    seen.add(digestOrbRunState(simulation));
    assert.equal(seen.size, 3, "the clock alone changes the digest");
    const again = await startOrbRunSimulation();
    try {
      again.advance(2);
      assert.equal(digestOrbRunState(again), digestOrbRunState(simulation));
    } finally {
      await again.dispose();
    }
  } finally {
    await simulation.dispose();
  }
});

test("the headless probe reaches the same digest as the replay player (state.replay.digest)", async () => {
  const { win } = await createOrbRunReplays();
  const probe = new OrbRunHeadlessProbe();
  try {
    await probe.start(ORB_RUN_SCENE_ID, 0);
    let held: string[] = [];
    let cursor = 1;
    const boundaries = [...win.inputs.map((input) => input.step), win.totalSteps + 1];
    // Steps before the first input run with nothing held.
    if (win.inputs[0]!.step > 1) await probe.step(win.inputs[0]!.step - 1);
    cursor = win.inputs[0]!.step;
    for (let i = 0; i < win.inputs.length; i += 1) {
      for (const action of held) await probe.input({ action, phase: "release" });
      held = Object.keys(win.inputs[i]!.actions);
      for (const action of held) await probe.input({ action, phase: "press", value: win.inputs[i]!.actions[action]! });
      const until = boundaries[i + 1]!;
      await probe.step(until - cursor);
      cursor = until;
    }
    const snapshot = await probe.snapshot();
    const state = snapshot.state as { replay: { step: number; digest: string }; game: { status: string } };
    assert.equal(state.replay.step, win.totalSteps);
    assert.equal(state.replay.digest, win.checkpoints.at(-1)?.digest);
    assert.equal(state.game.status, "won");
  } finally {
    await probe.close();
  }
});

test("recorder rules: only from step 0, needs a step, validates its interval, stops observing after finish", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    assert.throws(() => new OrbRunReplayRecorder(simulation, { checkpointEvery: 0 }), RangeError);
    assert.throws(() => new OrbRunReplayRecorder(simulation, { checkpointEvery: 1.5 }), RangeError);
    const recorder = new OrbRunReplayRecorder(simulation, { checkpointEvery: 10 });
    assert.throws(
      () => recorder.finish(),
      (error: unknown) => error instanceof OrbRunReplayError && error.code === "invalid_replay",
    );
    const second = new OrbRunReplayRecorder(simulation, { checkpointEvery: 10 });
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(25);
    const replay = second.finish();
    assert.deepEqual(replay.inputs, [{ step: 1, actions: { [ORB_RUN_ACTION.moveRight]: 1 } }]);
    assert.deepEqual(
      replay.checkpoints.map((checkpoint) => checkpoint.step),
      [10, 20, 25],
      "interval checkpoints plus the final one",
    );
    simulation.advance(5);
    assert.equal(second.finish().totalSteps, 30, "finish() after more steps still reports the simulation, but no longer records inputs");
    assert.throws(
      () => new OrbRunReplayRecorder(simulation),
      (error: unknown) => error instanceof OrbRunReplayError && error.code === "recorder_not_fresh",
    );
  } finally {
    await simulation.dispose();
  }
});

test("a recording keeps the held value and releases, not just presses", async () => {
  const replay = await recordOrbRunReplay((simulation) => {
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(3);
    simulation.setAction(ORB_RUN_ACTION.moveForward, 0.5);
    simulation.advance(2);
    simulation.releaseAllActions();
    simulation.advance(2);
  }, { checkpointEvery: 4 });
  assert.deepEqual(replay.inputs, [
    { step: 1, actions: { [ORB_RUN_ACTION.moveRight]: 1 } },
    { step: 4, actions: { [ORB_RUN_ACTION.moveForward]: 0.5, [ORB_RUN_ACTION.moveRight]: 1 } },
    { step: 6, actions: {} },
  ]);
  assert.equal(replay.totalSteps, 7);
  assert.equal((await playOrbRunReplay(replay)).verified, true);
});

test("malformed or hostile replays are refused with the path of the first problem", async () => {
  const { win } = await createOrbRunReplays();
  const bad = (mutate: (replay: Record<string, any>) => void): unknown => {
    const copy = clone(win) as unknown as Record<string, any>;
    mutate(copy);
    return copy;
  };
  const cases: Array<[string, unknown, string, string]> = [
    ["not an object", [], "invalid_replay", "$"],
    ["null", null, "invalid_replay", "$"],
    ["unknown field", bad((r) => (r.extra = 1)), "invalid_replay", "$.extra"],
    ["schema version", bad((r) => (r.schemaVersion = 2)), "invalid_replay", "$.schemaVersion"],
    ["other game", bad((r) => (r.game = "arena")), "invalid_replay", "$.game"],
    ["NaN step size", bad((r) => (r.fixedDeltaSeconds = Number.NaN)), "invalid_replay", "$.fixedDeltaSeconds"],
    ["zero step size", bad((r) => (r.fixedDeltaSeconds = 0)), "invalid_replay", "$.fixedDeltaSeconds"],
    ["zero steps", bad((r) => (r.totalSteps = 0)), "invalid_replay", "$.totalSteps"],
    ["absurd steps", bad((r) => (r.totalSteps = 10_000_000)), "invalid_replay", "$.totalSteps"],
    ["fractional steps", bad((r) => (r.totalSteps = 12.5)), "invalid_replay", "$.totalSteps"],
    ["inputs not an array", bad((r) => (r.inputs = {})), "invalid_replay", "$.inputs"],
    ["input past the end", bad((r) => (r.inputs[0].step = r.totalSteps + 1)), "invalid_replay", "$.inputs[0].step"],
    ["input at step 0", bad((r) => (r.inputs[0].step = 0)), "invalid_replay", "$.inputs[0].step"],
    ["inputs out of order", bad((r) => (r.inputs[1].step = r.inputs[0].step)), "invalid_replay", "$.inputs[1].step"],
    ["unknown input field", bad((r) => (r.inputs[0].phase = "press")), "invalid_replay", "$.inputs[0].phase"],
    ["unknown action", bad((r) => (r.inputs[0].actions = { "player.fly": 1 })), "unknown_action", "$.inputs[0].actions.player.fly"],
    [
      "held action of zero",
      bad((r) => (r.inputs[0].actions = { [ORB_RUN_ACTION.moveRight]: 0 })),
      "invalid_replay",
      `$.inputs[0].actions.${ORB_RUN_ACTION.moveRight}`,
    ],
    [
      "held action of NaN",
      bad((r) => (r.inputs[0].actions = { [ORB_RUN_ACTION.moveRight]: Number.NaN })),
      "invalid_replay",
      `$.inputs[0].actions.${ORB_RUN_ACTION.moveRight}`,
    ],
    ["no checkpoints", bad((r) => (r.checkpoints = [])), "invalid_replay", "$.checkpoints"],
    ["checkpoint digest", bad((r) => (r.checkpoints[0].digest = "xyz")), "invalid_replay", "$.checkpoints[0].digest"],
    ["upper-case digest", bad((r) => (r.checkpoints[0].digest = r.checkpoints[0].digest.toUpperCase())), "invalid_replay", "$.checkpoints[0].digest"],
    ["checkpoint order", bad((r) => (r.checkpoints[1].step = r.checkpoints[0].step)), "invalid_replay", "$.checkpoints[1].step"],
    ["missing final checkpoint", bad((r) => r.checkpoints.pop()), "invalid_replay", "$.checkpoints"],
    ["outcome status", bad((r) => (r.outcome.status = "draw")), "invalid_replay", "$.outcome.status"],
    ["outcome count", bad((r) => (r.outcome.collectedCount = -1)), "invalid_replay", "$.outcome.collectedCount"],
  ];
  for (const [label, input, code, path] of cases) {
    await assert.rejects(
      () => playOrbRunReplay(input),
      (error: unknown) => error instanceof OrbRunReplayError && error.code === code && error.path === path,
      `${label}: expected ${code} at ${path}`,
    );
  }
  assert.doesNotThrow(() => parseOrbRunReplay(win));
});

test("a replay recorded at another step size is refused, not played at the wrong speed", async () => {
  const { win } = await createOrbRunReplays();
  const other = { ...clone(win), fixedDeltaSeconds: 1 / 60 };
  await assert.rejects(
    () => playOrbRunReplay(other),
    (error: unknown) => error instanceof OrbRunReplayError && error.code === "step_mismatch",
  );
});
