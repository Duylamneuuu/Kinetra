import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import {
  AcceptanceRunner,
  acceptanceManifestSchema,
  type AcceptanceManifest,
  type AcceptanceReport,
} from "@kinetra/verification";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_SCENE_ID,
  OrbRunHeadlessProbe,
  createOrbRunProject,
} from "../src/index.js";

const MANIFESTS = ["win", "timeout", "save-load", "audio"] as const;

async function loadManifest(name: string): Promise<AcceptanceManifest> {
  // dist/test/*.js -> examples/orb-run/acceptance/
  const url = new URL(`../../acceptance/${name}.acceptance.json`, import.meta.url);
  return acceptanceManifestSchema.parse(JSON.parse(await readFile(url, "utf8")));
}

function manifest(steps: AcceptanceManifest["steps"], suite = "orb-run.inline"): AcceptanceManifest {
  return acceptanceManifestSchema.parse({ schemaVersion: 1, suite, steps });
}

function describeFailure(report: AcceptanceReport): string {
  const failed = report.steps.find((step) => !step.passed);
  return failed ? `step ${failed.index} (${failed.type}): ${failed.message ?? ""}` : "no failed step";
}

for (const name of MANIFESTS) {
  test(`acceptance manifest "${name}" passes on the engine AcceptanceRunner`, async () => {
    const loaded = await loadManifest(name);
    const probe = new OrbRunHeadlessProbe();
    const report = await new AcceptanceRunner(probe).run(loaded);
    assert.equal(report.passed, true, describeFailure(report));
    assert.equal(report.steps.length, loaded.steps.length, "every step ran");
    assert.ok(report.steps.every((step) => step.passed));
    assert.equal(probe.simulation, undefined, "the runner stopped the runtime");
  });
}

test("manifests target the authored scene id (guards against snapshot drift)", async () => {
  for (const name of MANIFESTS) {
    const loaded = await loadManifest(name);
    const start = loaded.steps[0];
    assert.equal(start?.type, "runtime.start");
    assert.equal(start?.type === "runtime.start" ? start.sceneId : undefined, ORB_RUN_SCENE_ID);
  }
});

test("the same manifest gives the same report outcome twice (determinism)", async () => {
  const loaded = await loadManifest("win");
  const observe = async () => {
    const probe = new OrbRunHeadlessProbe();
    await probe.start(ORB_RUN_SCENE_ID, 0);
    for (const step of loaded.steps.slice(1, -1)) {
      if (step.type === "input") {
        await probe.input({ action: step.action, phase: step.phase, durationMs: step.durationMs ?? 0 });
      }
      if (step.type === "wait") await probe.wait(step.milliseconds);
    }
    const snapshot = await probe.snapshot();
    await probe.stop();
    return snapshot;
  };
  assert.deepEqual(await observe(), await observe());
});

test("a wrong path fails with a structured missing-path diagnostic", async () => {
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.equal", path: "state.game.score", expected: 0 },
    ]),
  );
  assert.equal(report.passed, false);
  const failed = report.steps[1]!;
  assert.equal(failed.passed, false);
  assert.equal(failed.diagnostics?.kind, "missing_path");
  assert.equal(failed.diagnostics?.missingSegment, "score");
  assert.ok(failed.diagnostics?.availableKeys.includes("status"));
});

test("visual steps fail loudly instead of passing without a renderer", async () => {
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.screenshotValidPng" },
    ]),
  );
  assert.equal(report.passed, false);
  assert.match(report.steps[1]?.message ?? "", /no renderer/);
});

test("starting another scene, vector input and a non-fixed step are rejected", async () => {
  const runner = new AcceptanceRunner(new OrbRunHeadlessProbe());
  const wrongScene = await runner.run(manifest([{ type: "runtime.start", sceneId: "scene_missing" }]));
  assert.equal(wrongScene.passed, false);
  assert.match(wrongScene.steps[0]?.message ?? "", /can only start scene/);

  const vector = await runner.run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "input", action: "player.moveRight", phase: "press", value: [1, 0] },
    ]),
  );
  assert.equal(vector.passed, false);
  assert.match(vector.steps[1]?.message ?? "", /scalar/);

  const variableStep = await runner.run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "runtime.step", steps: 2, deltaSeconds: 0.1 },
    ]),
  );
  assert.equal(variableStep.passed, false);
  assert.match(variableStep.steps[1]?.message ?? "", /fixed step/);
});

test("pause freezes virtual time; press/release holds an action across waits", async () => {
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "runtime.pause" },
      { type: "wait", milliseconds: 5000 },
      { type: "assert.equal", path: "state.game.step", expected: 0 },
      { type: "assert.equal", path: "state.paused", expected: true },
      { type: "runtime.resume" },
      { type: "input", action: "player.moveRight", phase: "press" },
      { type: "wait", milliseconds: 1000 },
      { type: "runtime.step", steps: 30 },
      { type: "input", action: "player.moveRight", phase: "release" },
      { type: "wait", milliseconds: 1000 },
      { type: "assert.equal", path: "state.game.step", expected: 90 },
      { type: "assert.near", path: "state.entities.Player.position.0", expected: 4, tolerance: 0.01 },
      { type: "assert.equal", path: "state.game.collectedCount", expected: 1 },
      { type: "assert.metricMin", metric: "simulation.steps", min: 90 },
    ]),
  );
  assert.equal(report.passed, true, describeFailure(report));
});

test("a corrupt save is rejected and the running game is untouched", async () => {
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "input", action: "player.moveRight", phase: "hold", durationMs: 2000 },
      {
        type: "save.load",
        envelope: {
          schemaVersion: 1,
          step: 10,
          positions: {},
          scripts: { [ORB_RUN_ENTITY.manager]: { status: "won", collectedOrbIds: [], exitUnlocked: true, elapsedSeconds: 1 } },
        },
      },
    ]),
  );
  assert.equal(report.passed, false);
  assert.match(report.steps[2]?.message ?? "", /exitUnlocked requires every orb/);

  const probe = new OrbRunHeadlessProbe();
  await probe.start(ORB_RUN_SCENE_ID, 0);
  await probe.input({ action: "player.moveRight", phase: "hold", durationMs: 2000 });
  const before = await probe.snapshot();
  const missing = await probe.loadSave({ slotId: "never-saved" });
  assert.equal(missing.success, false);
  const badSchema = await probe.loadSave({ envelope: { schemaVersion: 2, step: 0, positions: {}, scripts: {} } });
  assert.equal(badSchema.success, false);
  assert.match(badSchema.error ?? "", /schema/);
  assert.deepEqual(await probe.snapshot(), before);
  await probe.stop();
});

test("a rebalanced project (5 s clock via the command bus) fails the win manifest at the win check", async () => {
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "tighten-clock",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: { timeLimitSeconds: 5 } },
  });
  const report = await new AcceptanceRunner(new OrbRunHeadlessProbe({ project: bus.snapshot().project })).run(
    await loadManifest("win"),
  );
  assert.equal(report.passed, false);
  const failed = report.steps.find((step) => !step.passed)!;
  assert.equal(failed.type, "assert.equal");
  assert.equal(failed.actual, 2, "the clock runs out after the second orb");
  assert.equal(failed.expected, 3);
});

test("a typo'd script id fails acceptance and surfaces as an error log", async () => {
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "typo",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.orbB, component: "Script", patch: { scriptId: "OrbRunOrbTypo" } },
  });
  const probe = new OrbRunHeadlessProbe({ project: bus.snapshot().project });
  const report = await new AcceptanceRunner(probe).run(
    manifest([
      { type: "runtime.start", sceneId: ORB_RUN_SCENE_ID },
      { type: "assert.logAbsent", minimumLevel: "error" },
    ]),
  );
  assert.equal(report.passed, false);
  assert.match(report.steps[1]?.message ?? "", /script\.resolveFailed/);
});
