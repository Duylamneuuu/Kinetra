import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceRunner,
  acceptanceManifestSchema,
  type AcceptanceManifest,
  type RuntimeSnapshot,
} from "@kinetra/verification";

import { ORB_RUN_MAX_STEPS_PER_CALL, ORB_RUN_SCENE_ID, OrbRunHeadlessProbe } from "../src/index.js";

function manifest(steps: AcceptanceManifest["steps"]): AcceptanceManifest {
  return acceptanceManifestSchema.parse({ schemaVersion: 1, suite: "orb-run.probe-bounds", steps });
}

function playerX(snapshot: RuntimeSnapshot): number {
  return (snapshot.state.entities as Record<string, { position: number[] }>).Player!.position[0]!;
}

async function started(): Promise<OrbRunHeadlessProbe> {
  const probe = new OrbRunHeadlessProbe();
  await probe.start(ORB_RUN_SCENE_ID, 0);
  return probe;
}

test("step rejects counts the Electron player would reject, instead of silently doing nothing", async () => {
  const probe = await started();
  try {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, ORB_RUN_MAX_STEPS_PER_CALL + 1]) {
      await assert.rejects(() => probe.step(bad), TypeError, `steps=${String(bad)}`);
    }
    assert.equal(probe.simulation?.step, 0, "a rejected step advanced nothing");
    await probe.step(0);
    assert.equal(probe.simulation?.step, 0, "steps=0 is allowed and is a no-op");
    await probe.step(ORB_RUN_MAX_STEPS_PER_CALL > 3 ? 3 : 1);
    assert.equal(probe.simulation?.step, 3);
  } finally {
    await probe.stop();
  }
});

test("step rejects a non-positive or non-finite deltaSeconds", async () => {
  const probe = await started();
  try {
    const fixed = probe.simulation!.fixedDeltaSeconds;
    for (const bad of [Number.NaN, 0, -fixed, Number.POSITIVE_INFINITY]) {
      await assert.rejects(() => probe.step(1, bad), TypeError, `deltaSeconds=${String(bad)}`);
    }
    await probe.step(1, fixed);
    assert.equal(probe.simulation?.step, 1);
  } finally {
    await probe.stop();
  }
});

test("wait and hold refuse durations that round to zero steps or exceed the per-call limit", async () => {
  const probe = await started();
  try {
    const fixedMs = probe.simulation!.fixedDeltaSeconds * 1000;
    await assert.rejects(() => probe.wait(fixedMs / 4), RangeError);
    await assert.rejects(
      () => probe.input({ action: "player.moveRight", phase: "hold", durationMs: fixedMs / 4 }),
      RangeError,
    );
    await assert.rejects(() => probe.wait(fixedMs * (ORB_RUN_MAX_STEPS_PER_CALL + 10)), RangeError);
    await assert.rejects(() => probe.wait(Number.NaN), RangeError);
    await assert.rejects(() => probe.wait(-1), RangeError);
    assert.equal(probe.simulation?.step, 0);
    await probe.wait(0);
    assert.equal(probe.simulation?.step, 0, "wait 0 is a legal no-op");
    await probe.wait(fixedMs * 2);
    assert.equal(probe.simulation?.step, 2);
  } finally {
    await probe.stop();
  }
});

test("a rejected hold does not leave the action pressed", async () => {
  const probe = await started();
  try {
    const fixedMs = probe.simulation!.fixedDeltaSeconds * 1000;
    await assert.rejects(
      () => probe.input({ action: "player.moveRight", phase: "hold", durationMs: fixedMs / 4 }),
      RangeError,
    );
    const startX = playerX(await probe.snapshot());
    await probe.step(30);
    assert.equal(playerX(await probe.snapshot()), startX, "the player did not move");
  } finally {
    await probe.stop();
  }
});

test("input sent while paused is dropped, like the player's inputBlockedWhilePaused, and does not leak after resume", async () => {
  const probe = await started();
  try {
    const startX = playerX(await probe.snapshot());
    await probe.pause();
    await probe.input({ action: "player.moveRight", phase: "press" });
    await probe.step(30);
    await probe.resume();
    await probe.step(30);
    const snapshot = await probe.snapshot();
    assert.equal(playerX(snapshot), startX, "the press made during the pause never reached the game");
    assert.equal((snapshot.state.game as { step: number }).step, 30, "step while paused advances nothing");
  } finally {
    await probe.stop();
  }
});

test("step while paused is a no-op, matching runtime.step in the player (pause then step then resume)", async () => {
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "runtime.pause" },
      { type: "runtime.step", steps: 10 },
      { type: "assert.equal", path: "state.game.step", expected: 0 },
      { type: "runtime.resume" },
      { type: "runtime.step", steps: 10 },
      { type: "assert.equal", path: "state.game.step", expected: 10 },
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(report.steps.find((step) => !step.passed)));
});

test("a bad step count surfaces as a failed manifest step with a message", async () => {
  const runner = new AcceptanceRunner(new OrbRunHeadlessProbe());
  const report = await runner.run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "runtime.step", steps: 1_000_000 },
    ]),
  );
  assert.equal(report.passed, false);
  assert.match(report.steps[1]?.message ?? "", /steps must be an integer from 0 to 36000/);
});
