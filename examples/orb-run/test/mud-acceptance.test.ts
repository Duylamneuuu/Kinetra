import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";
import { AcceptanceRunner, acceptanceManifestSchema, type AcceptanceManifest } from "@kinetra/verification";

import {
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_SCENE_ID,
  ORB_RUN_SLOW_ZONE_COMPONENT,
  OrbRunHeadlessProbe,
  createOrbRunProject,
  orbRunSlowZoneComponents,
} from "../src/index.js";
import { createOrbRunNavigationProbe, planOrbRunRoute } from "../src/navigation.js";

/**
 * Mud (`OrbRunSlowZone`) seen the way an agent sees a level: through an `AcceptanceManifest` run by the engine's own
 * `AcceptanceRunner`. Review follow-up #437 (item 2): `state.level.walls.*` could be asserted from a manifest, but nothing
 * pinned `state.level.slowZones.*`, so "this level has mud here" had no acceptance coverage (the report field exists since
 * slice 21, the manifest path to it was never exercised).
 */

const MUD_ID = "mud-start";
/** Mud around the player's start (-4, -4), the same patch `slow-zones.test.ts` uses. */
const MUD = { centre: { x: -4, z: -4 }, radius: 3, speedMultiplier: 0.4 };

function withMud(): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  const result = bus.execute({
    requestId: "mud",
    command: "entity.create",
    expectedProjectRevision: bus.revision,
    payload: {
      sceneId: ORB_RUN_SCENE_ID,
      entity: { id: MUD_ID, name: "Mud start", components: orbRunSlowZoneComponents(MUD.centre, MUD) as ComponentMap },
    },
  });
  assert.equal(result.ok, true);
  return bus.snapshot().project;
}

function manifest(suite: string, steps: Array<Record<string, unknown>>): AcceptanceManifest {
  return acceptanceManifestSchema.parse({
    schemaVersion: 1,
    suite,
    seed: 0,
    target: "runtime",
    steps: [{ type: "runtime.start", sceneId: ORB_RUN_SCENE_ID }, ...steps],
  });
}

const equal = (path: string, expected: unknown): Record<string, unknown> => ({ type: "assert.equal", path, expected });
const near = (path: string, expected: number, tolerance: number): Record<string, unknown> => ({
  type: "assert.near",
  path,
  expected,
  tolerance,
});

function failedStep(report: Awaited<ReturnType<AcceptanceRunner["run"]>>): { index: number; type: string; message: string } | undefined {
  const step = report.steps.find((candidate) => !candidate.passed);
  return step ? { index: step.index, type: step.type, message: step.message ?? "" } : undefined;
}

/** 18 fixed steps at 1/30 s (600 ms): all of them start inside the 3 m patch, so every one moves playerSpeed x 0.4 x dt. */
const HOLD_MS = 600;
const HOLD_STEPS = 18;

test("a muddy level: the zone and the withdrawn playtest claim are asserted from a manifest, and the player really slows down", async () => {
  const project = withMud();
  const plan = await planOrbRunRoute(project);
  const dt = 1 / 30;
  const mudMetres = ORB_RUN_DEFAULT_RULES.playerSpeed * MUD.speedMultiplier * dt * HOLD_STEPS;
  const report = await new AcceptanceRunner(createOrbRunNavigationProbe({ project })).run(
    manifest("orb-run.mud", [
      // The level check reports the patch exactly as authored and stops claiming a full-speed playtest time.
      equal("state.level.ok", true),
      equal("state.level.verdict", "unproven"),
      equal("state.level.slowZones.0.entityId", MUD_ID),
      equal("state.level.slowZones.0.x", MUD.centre.x),
      equal("state.level.slowZones.0.z", MUD.centre.z),
      equal("state.level.slowZones.0.radius", MUD.radius),
      equal("state.level.slowZones.0.speedMultiplier", MUD.speedMultiplier),
      equal("state.level.diagnostics.0.code", "slow_zones_present"),
      equal("state.level.playtestSeconds", null),
      equal("state.level.slackSeconds", null),
      equal("state.level.route", null),
      equal("state.level.walls", []),
      // The navigation plan prices the mud instead of ignoring it.
      equal("state.navigation.ok", true),
      equal("state.navigation.slowZoneCount", 1),
      near("state.navigation.mudSeconds", plan.mudSeconds!, 1e-9),
      // Walking right from the start: every step is in the mud, so the player covers 40% of the open-ground distance.
      { type: "input", action: "player.moveRight", phase: "hold", durationMs: HOLD_MS },
      near("state.entities.Player.position.0", -4 + mudMetres, 1e-6),
      near("state.entities.Player.position.2", -4, 1e-9),
      equal("state.game.status", "playing"),
    ]),
  );
  assert.equal(report.passed, true, JSON.stringify(failedStep(report)));
  assert.ok(plan.mudSeconds! > 0, `the winning route crosses the mud (${plan.mudSeconds} s)`);
});

test("the same walk on open ground goes 2.5x as far, and a manifest that expects mud there fails on the zone read", async () => {
  const dt = 1 / 30;
  const openMetres = ORB_RUN_DEFAULT_RULES.playerSpeed * dt * HOLD_STEPS;
  const open = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest("orb-run.open-walk", [
      equal("state.level.slowZones", []),
      { type: "input", action: "player.moveRight", phase: "hold", durationMs: HOLD_MS },
      near("state.entities.Player.position.0", -4 + openMetres, 1e-6),
    ]),
  );
  assert.equal(open.passed, true, JSON.stringify(failedStep(open)));

  const wrong = await new AcceptanceRunner(new OrbRunHeadlessProbe()).run(
    manifest("orb-run.mud-expected-on-open-ground", [equal("state.level.slowZones.0.entityId", MUD_ID)]),
  );
  assert.equal(wrong.passed, false);
  const failure = failedStep(wrong)!;
  assert.equal(failure.index, 1, "reading a zone that is not there fails the step itself, it never passes on nothing");
  assert.match(failure.message, /state\.level\.slowZones\.0\.entityId/);
});

test("a mud patch broken after authoring fails the manifest at runtime.start instead of running a level without its mud", async () => {
  const bus = new CommandBus(withMud());
  const patched = bus.execute({
    requestId: "break-zone",
    command: "component.patch",
    payload: { entityId: MUD_ID, component: ORB_RUN_SLOW_ZONE_COMPONENT, patch: { speedMultiplier: 3 } as never },
  });
  assert.equal(patched.ok, true, "the command bus stores custom component data as authored");
  const probe = new OrbRunHeadlessProbe({ project: bus.snapshot().project });
  const report = await new AcceptanceRunner(probe).run(manifest("orb-run.mud-broken", [equal("state.game.status", "playing")]));
  assert.equal(report.passed, false);
  const failure = failedStep(report)!;
  assert.equal(failure.index, 0);
  assert.equal(failure.type, "runtime.start");
  assert.match(failure.message, /OrbRunSlowZone invalid/);
  await probe.close();
});
