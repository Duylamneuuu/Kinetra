import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import { AcceptanceRunner, acceptanceManifestSchema, type AcceptanceManifest } from "@kinetra/verification";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_REPLAY_YIELD_EVERY_STEPS,
  ORB_RUN_RULES_COMPONENT,
  OrbRunHeadlessProbe,
  OrbRunReplayError,
  createOrbRunProject,
  createOrbRunReplayManifest,
  createOrbRunReplays,
  digestOrbRunState,
  playOrbRunReplay,
  recordOrbRunReplay,
  startOrbRunSimulation,
  type OrbRunReplay,
} from "../src/index.js";

async function committedManifest(name: "win" | "timeout"): Promise<AcceptanceManifest> {
  // dist/test/*.js -> examples/orb-run/acceptance/
  const url = new URL(`../../acceptance/replay-${name}.acceptance.json`, import.meta.url);
  return acceptanceManifestSchema.parse(JSON.parse(await readFile(url, "utf8")));
}

test("the committed replay manifests are exactly what the golden recordings generate (no stale digest)", async () => {
  const replays = await createOrbRunReplays();
  for (const name of ["win", "timeout"] as const) {
    const generated = createOrbRunReplayManifest(replays[name], `orb-run.replay-${name}`);
    assert.deepEqual(
      await committedManifest(name),
      generated,
      `replay-${name}.acceptance.json is stale; run \`pnpm --filter @kinetra/example-orb-run snapshot\``,
    );
  }
});

test("a replay manifest pins the digest at every checkpoint and passes on the engine AcceptanceRunner", async () => {
  const { win } = await createOrbRunReplays();
  const manifest = await committedManifest("win");
  const pinned = manifest.steps.filter((step) => step.type === "assert.equal" && step.path === "state.replay.digest");
  assert.equal(pinned.length, win.checkpoints.length, "one digest assertion per checkpoint");
  assert.deepEqual(
    pinned.map((step) => (step.type === "assert.equal" ? step.expected : undefined)),
    win.checkpoints.map((checkpoint) => checkpoint.digest),
  );
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(manifest);
  assert.equal(report.passed, true, JSON.stringify(report.steps.find((step) => !step.passed)));
  assert.equal(report.steps.length, manifest.steps.length);
});

test("the idle timeout recording is also a passing manifest with no input steps", async () => {
  const manifest = await committedManifest("timeout");
  assert.equal(manifest.steps.some((step) => step.type === "input"), false);
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(manifest);
  assert.equal(report.passed, true);
});

test("a rebalanced game fails the replay manifest at the first checkpoint that moved, with the engine's own diagnostic", async () => {
  const { win } = await createOrbRunReplays();
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "slow-runner",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { playerSpeed: 2 } },
  });
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe({ project: bus.snapshot().project })).run(
    await committedManifest("win"),
  );
  assert.equal(report.passed, false);
  const failed = report.steps.find((step) => !step.passed)!;
  assert.equal(failed.type, "assert.equal");
  // The replay player says the same thing: the first diverging checkpoint is the failed digest assertion.
  const replay = await playOrbRunReplay(win, { project: bus.snapshot().project });
  const previous = report.steps[failed.index - 1]!;
  assert.equal(previous.passed, true, "the step count assertion right before the digest still holds");
  assert.equal(replay.divergence?.expected, failed.expected);
  assert.equal(replay.divergence?.actual, failed.actual);
});

test("the digest covers every entity with a position, not only the scripted ones", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    const positions = simulation.positions();
    assert.ok(ORB_RUN_ENTITY.camera in positions, "the unscripted camera has a runtime position");
    assert.deepEqual(Object.keys(positions), Object.keys(positions).sort(), "positions come back in sorted id order");
    const before = digestOrbRunState(simulation);
    const moved = simulation.getPosition(ORB_RUN_ENTITY.camera)!;
    simulation.restorePosition(ORB_RUN_ENTITY.camera, [moved[0] + 1, moved[1], moved[2]]);
    assert.notEqual(digestOrbRunState(simulation), before, "moving an unscripted entity changes the digest");
    simulation.restorePosition(ORB_RUN_ENTITY.camera, moved);
    assert.equal(digestOrbRunState(simulation), before);
    // The copy is detached: editing it does not move the entity.
    simulation.positions()[ORB_RUN_ENTITY.camera]![0] = 999;
    assert.equal(digestOrbRunState(simulation), before);
  } finally {
    await simulation.dispose();
  }
});

async function longReplay(steps: number): Promise<OrbRunReplay> {
  return recordOrbRunReplay((simulation) => {
    simulation.advance(steps);
  }, { checkpointEvery: 1000 });
}

test("a long replay yields to the event loop instead of blocking its host", async () => {
  const steps = ORB_RUN_REPLAY_YIELD_EVERY_STEPS * 3 + 5;
  const replay = await longReplay(steps);
  let ticks = 0;
  let done = false;
  const ticker = (async () => {
    while (!done) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      ticks += 1;
    }
  })();
  const result = await playOrbRunReplay(replay);
  done = true;
  await ticker;
  assert.equal(result.verified, true);
  assert.equal(result.summary.step, steps);
  assert.ok(ticks >= 3, `the host loop got ${ticks} turns during ${steps} steps`);
});

test("replay playback can be capped by maxSteps and cancelled with an AbortSignal", async () => {
  const replay = await longReplay(ORB_RUN_REPLAY_YIELD_EVERY_STEPS + 10);

  await assert.rejects(
    () => playOrbRunReplay(replay, { maxSteps: replay.totalSteps - 1 }),
    (error: unknown) => error instanceof OrbRunReplayError && error.code === "replay_too_long" && error.path === "$.totalSteps",
  );
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(() => playOrbRunReplay(replay, { maxSteps: bad }), RangeError);
  }
  assert.equal((await playOrbRunReplay(replay, { maxSteps: replay.totalSteps })).verified, true, "exactly at the cap is allowed");

  const before = new AbortController();
  before.abort();
  let stepsRun = 0;
  await assert.rejects(
    () => playOrbRunReplay(replay, { signal: before.signal, onStep: () => (stepsRun += 1) }),
    (error: unknown) => error instanceof OrbRunReplayError && error.code === "aborted",
  );
  assert.equal(stepsRun, 0, "an already-aborted signal runs nothing");

  const during = new AbortController();
  stepsRun = 0;
  await assert.rejects(
    () =>
      playOrbRunReplay(replay, {
        signal: during.signal,
        onStep: (simulation) => {
          stepsRun += 1;
          if (simulation.step === 100) during.abort();
        },
      }),
    (error: unknown) => error instanceof OrbRunReplayError && error.code === "aborted",
  );
  assert.equal(stepsRun, ORB_RUN_REPLAY_YIELD_EVERY_STEPS, "playback stops at the next yield point, not at the end");
});
