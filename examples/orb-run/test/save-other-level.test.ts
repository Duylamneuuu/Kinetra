import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_RULES_COMPONENT,
  ORB_RUN_WINNING_ROUTE,
  captureOrbRunSave,
  createOrbRunProject,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  validateOrbRunSave,
  walkTo,
  type HeadlessSceneSimulation,
  type OrbRunSaveData,
  type OrbRunSaveIssue,
} from "../src/index.js";

/**
 * Saves written for another level, or edited by hand. The engine ignores the derived numbers the manager writes next
 * to its real state (`totalOrbs`, `collectedCount`, `remainingSeconds`), so before this slice a save from a level with
 * another time limit loaded without a word and a hand-edited counter went unnoticed. A "won" save also never said
 * where the player stood.
 */

const MANAGER = `scripts.${ORB_RUN_ENTITY.manager}`;
const PLAYER = `positions.${ORB_RUN_ENTITY.player}`;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function mutated(save: OrbRunSaveData, change: (draft: Json) => void): OrbRunSaveData {
  const draft = structuredClone(save) as unknown as Json;
  change(draft);
  return draft as unknown as OrbRunSaveData;
}

function paths(issues: readonly OrbRunSaveIssue[]): string[] {
  return issues.map((issue) => issue.path).sort();
}

function withRules(rules: Record<string, number>): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  const result = bus.execute({
    requestId: "rules",
    command: "component.patch",
    payload: { entityId: ORB_RUN_ENTITY.manager, component: ORB_RUN_RULES_COMPONENT, patch: rules as never },
  });
  assert.equal(result.ok, true);
  return bus.snapshot().project;
}

async function saveAfter(project: ProjectDocument | undefined, orbs: number): Promise<OrbRunSaveData> {
  const simulation = await startOrbRunSimulation(project);
  try {
    for (const target of ORB_RUN_WINNING_ROUTE.slice(0, orbs)) walkTo(simulation, target);
    return JSON.parse(JSON.stringify(captureOrbRunSave(simulation))) as OrbRunSaveData;
  } finally {
    await simulation.dispose();
  }
}

async function wonSave(): Promise<{ save: OrbRunSaveData; exit: [number, number, number] }> {
  const simulation = await startOrbRunSimulation();
  try {
    for (const target of ORB_RUN_WINNING_ROUTE) {
      walkTo(simulation, target, { stopWhen: () => summarizeOrbRun(simulation).status !== "playing" });
    }
    simulation.advance(1);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    const exit = simulation.getPosition(ORB_RUN_ENTITY.exit);
    assert.ok(exit);
    return { save: JSON.parse(JSON.stringify(captureOrbRunSave(simulation))) as OrbRunSaveData, exit };
  } finally {
    await simulation.dispose();
  }
}

async function refused(
  simulation: HeadlessSceneSimulation,
  save: unknown,
  expectedPaths: readonly string[],
): Promise<OrbRunSaveIssue[]> {
  const before = JSON.stringify(captureOrbRunSave(simulation));
  const issues = validateOrbRunSave(simulation, save);
  assert.deepEqual(paths(issues), [...expectedPaths].sort());
  await assert.rejects(restoreOrbRunSave(simulation, save as OrbRunSaveData), { code: "ORB_RUN_SAVE_INVALID" });
  assert.equal(JSON.stringify(captureOrbRunSave(simulation)), before, "a refused save changes nothing");
  return issues;
}

test("a save from a level with another time limit is refused, in both directions", async () => {
  const generous = withRules({ timeLimitSeconds: 90 });
  const strict = withRules({ timeLimitSeconds: 45 });
  const fromGenerous = await saveAfter(generous, 2);
  const fromStrict = await saveAfter(strict, 2);

  const onStrict = await startOrbRunSimulation(strict);
  try {
    assert.deepEqual(validateOrbRunSave(onStrict, fromStrict), [], "its own level's save is accepted");
    const issues = await refused(onStrict, fromGenerous, [`${MANAGER}.remainingSeconds`]);
    assert.match(issues[0]!.message, /allows 45 s/);
  } finally {
    await onStrict.dispose();
  }
  const onGenerous = await startOrbRunSimulation(generous);
  try {
    assert.deepEqual(validateOrbRunSave(onGenerous, fromGenerous), []);
    await refused(onGenerous, fromStrict, [`${MANAGER}.remainingSeconds`]);
  } finally {
    await onGenerous.dispose();
  }
});

test("a hand-edited counter in the manager state is refused with its own path", async () => {
  const good = await saveAfter(undefined, 2);
  const simulation = await startOrbRunSimulation();
  try {
    assert.deepEqual(validateOrbRunSave(simulation, good), []);
    await refused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.manager].totalOrbs = 4)), [`${MANAGER}.totalOrbs`]);
    await refused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.manager].collectedCount = 3)), [
      `${MANAGER}.collectedCount`,
    ]);
    await refused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.manager].remainingSeconds = 0)), [
      `${MANAGER}.remainingSeconds`,
    ]);
    await refused(simulation, mutated(good, (d) => delete d.scripts[ORB_RUN_ENTITY.manager].totalOrbs), [`${MANAGER}.totalOrbs`]);
    // All three at once are all reported.
    await refused(
      simulation,
      mutated(good, (d) => {
        const manager = d.scripts[ORB_RUN_ENTITY.manager];
        manager.totalOrbs = 9;
        manager.collectedCount = 0;
        manager.remainingSeconds = -1;
      }),
      [`${MANAGER}.totalOrbs`, `${MANAGER}.collectedCount`, `${MANAGER}.remainingSeconds`],
    );
  } finally {
    await simulation.dispose();
  }
});

test("a run that ran out of time keeps remainingSeconds at exactly 0", async () => {
  const simulation = await startOrbRunSimulation(withRules({ timeLimitSeconds: 2 }));
  try {
    simulation.advance(90);
    assert.equal(summarizeOrbRun(simulation).status, "lost");
    const save = JSON.parse(JSON.stringify(captureOrbRunSave(simulation))) as OrbRunSaveData;
    assert.equal((save.scripts[ORB_RUN_ENTITY.manager] as Json).remainingSeconds, 0);
    assert.deepEqual(validateOrbRunSave(simulation, save), []);
    await refused(simulation, mutated(save, (d) => (d.scripts[ORB_RUN_ENTITY.manager].remainingSeconds = 0.5)), [
      `${MANAGER}.remainingSeconds`,
    ]);
  } finally {
    await simulation.dispose();
  }
});

test("a won save puts the player at the exit: far away is refused, the edge of the reach is legal", async () => {
  const { save, exit } = await wonSave();
  const simulation = await startOrbRunSimulation();
  try {
    assert.deepEqual(validateOrbRunSave(simulation, save), [], "the real winning save is accepted");
    const far = mutated(save, (d) => (d.positions[ORB_RUN_ENTITY.player] = [-4, 0.5, -4]));
    const [issue] = await refused(simulation, far, [PLAYER]);
    assert.match(issue!.message, /at the exit/);

    // Radius 1 plus one step (4 m/s x 1/30 s) is the farthest a won run can leave the player from the exit.
    const reach = 1 + 4 * simulation.fixedDeltaSeconds;
    const at = (distance: number) =>
      mutated(save, (d) => (d.positions[ORB_RUN_ENTITY.player] = [exit[0] - distance, 0.5, exit[2]]));
    assert.deepEqual(validateOrbRunSave(simulation, at(1)), []);
    assert.deepEqual(validateOrbRunSave(simulation, at(reach - 0.001)), []);
    assert.deepEqual(paths(validateOrbRunSave(simulation, at(reach + 0.01))), [PLAYER]);
  } finally {
    await simulation.dispose();
  }
});

test("the exit rule only judges won runs: the same far position is fine while still playing", async () => {
  const playing = await saveAfter(undefined, 2);
  const simulation = await startOrbRunSimulation();
  try {
    const [px, , pz] = playing.positions[ORB_RUN_ENTITY.player]!;
    const exit = simulation.getPosition(ORB_RUN_ENTITY.exit)!;
    assert.ok(Math.hypot(px - exit[0], pz - exit[2]) > 2, "the mid-run player is away from the exit");
    assert.deepEqual(validateOrbRunSave(simulation, playing), []);
  } finally {
    await simulation.dispose();
  }
});
