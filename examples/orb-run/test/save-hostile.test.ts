import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";

import {
  ORB_RUN_ENTITY,
  ORB_RUN_SCENE_ID,
  ORB_RUN_WINNING_ROUTE,
  OrbRunSaveError,
  captureOrbRunSave,
  createOrbRunProject,
  driveOrbRunFuzz,
  orbRunWallComponents,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  validateOrbRunSave,
  walkTo,
  type HeadlessSceneSimulation,
  type OrbRunFuzzStrategy,
  type OrbRunSaveData,
  type OrbRunSaveIssue,
} from "../src/index.js";

/** A save taken after two orbs, round-tripped through JSON like a file on disk. */
async function midRunSave(project?: ProjectDocument): Promise<OrbRunSaveData> {
  const simulation = await startOrbRunSimulation(project);
  try {
    for (const target of ORB_RUN_WINNING_ROUTE.slice(0, 2)) walkTo(simulation, target);
    assert.equal(summarizeOrbRun(simulation).collectedCount, 2);
    return JSON.parse(JSON.stringify(captureOrbRunSave(simulation))) as OrbRunSaveData;
  } finally {
    await simulation.dispose();
  }
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function mutated(save: OrbRunSaveData, change: (draft: Json) => void): OrbRunSaveData {
  const draft = structuredClone(save) as unknown as Json;
  change(draft);
  return draft as unknown as OrbRunSaveData;
}

function paths(issues: readonly OrbRunSaveIssue[]): string[] {
  return issues.map((issue) => issue.path).sort();
}

const MANAGER = `scripts.${ORB_RUN_ENTITY.manager}`;

/** A hostile save is refused with a structured error and leaves the running game byte for byte as it was. */
async function assertRefused(
  simulation: HeadlessSceneSimulation,
  save: unknown,
  expectedPaths: readonly string[],
): Promise<OrbRunSaveIssue[]> {
  const before = JSON.stringify(captureOrbRunSave(simulation));
  const revision = simulation.stateRevision;
  let caught: unknown;
  try {
    await restoreOrbRunSave(simulation, save as OrbRunSaveData);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof OrbRunSaveError, `expected OrbRunSaveError, got ${String(caught)}`);
  assert.equal(caught.code, "ORB_RUN_SAVE_INVALID");
  assert.deepEqual(paths(caught.issues), [...expectedPaths].sort(), caught.message);
  assert.deepEqual(paths(validateOrbRunSave(simulation, save)), [...expectedPaths].sort());
  assert.equal(JSON.stringify(captureOrbRunSave(simulation)), before, "a refused save changed the game");
  assert.equal(simulation.stateRevision, revision, "a refused save touched the simulation");
  return caught.issues;
}

test("a legitimate save is accepted at every point of fuzzed runs (no false rejections)", async () => {
  const strategies: OrbRunFuzzStrategy[] = ["random", "seek", "mixed"];
  let checked = 0;
  let rejected: string[] = [];
  const outcomes = new Set<string>();
  for (let seed = 1; seed <= 36; seed += 1) {
    const simulation = await startOrbRunSimulation();
    try {
      simulation.onStep((sim) => {
        const save = captureOrbRunSave(sim);
        const issues = validateOrbRunSave(sim, JSON.parse(JSON.stringify(save)));
        checked += 1;
        if (issues.length > 0) {
          rejected.push(`seed ${seed} step ${sim.step}: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
        }
      });
      driveOrbRunFuzz(simulation, { seed, steps: 800, strategy: strategies[seed % 3]! });
      outcomes.add(summarizeOrbRun(simulation).status);
      rejected = rejected.slice(0, 5);
    } finally {
      await simulation.dispose();
    }
  }
  assert.deepEqual(rejected, []);
  assert.ok(checked >= 36 * 800);
  // The sweep covered unfinished, won and lost runs, so every branch of the verdict rules was exercised.
  assert.ok(outcomes.has("lost"), `outcomes: ${[...outcomes].join(",")}`);
});

test("a winning run's save is accepted and restores into a finished game", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    for (const target of ORB_RUN_WINNING_ROUTE) walkTo(simulation, target, { stopWhen: () => summarizeOrbRun(simulation).status !== "playing" });
    simulation.advance(1);
    assert.equal(summarizeOrbRun(simulation).status, "won");
    const save = JSON.parse(JSON.stringify(captureOrbRunSave(simulation))) as OrbRunSaveData;
    assert.deepEqual(validateOrbRunSave(simulation, save), []);
    const fresh = await startOrbRunSimulation();
    try {
      await restoreOrbRunSave(fresh, save);
      assert.equal(summarizeOrbRun(fresh).status, "won");
      assert.equal(fresh.scriptState(ORB_RUN_ENTITY.player)?.state?.finished, true);
    } finally {
      await fresh.dispose();
    }
  } finally {
    await simulation.dispose();
  }
});

test("a save that is not a save at all is refused", async () => {
  const simulation = await startOrbRunSimulation();
  try {
    for (const junk of [null, undefined, 42, "save", [], true]) {
      await assertRefused(simulation, junk, [""]);
    }
    await assertRefused(simulation, {}, ["positions", "schemaVersion", "scripts", "step"]);
    await assertRefused(simulation, { schemaVersion: 1, step: 0, positions: [], scripts: "x" }, ["positions", "scripts"]);
  } finally {
    await simulation.dispose();
  }
});

test("hostile envelopes: wrong schema, unknown fields, bad step, missing or foreign entities", async () => {
  const good = await midRunSave();
  const simulation = await startOrbRunSimulation();
  try {
    await assertRefused(simulation, mutated(good, (d) => (d.schemaVersion = 2)), ["schemaVersion"]);
    await assertRefused(simulation, mutated(good, (d) => (d.cheats = { godMode: true })), ["cheats"]);
    for (const step of [-1, 1.5, "3", null, Number.NaN]) {
      await assertRefused(simulation, mutated(good, (d) => (d.step = step)), ["step"]);
    }
    await assertRefused(simulation, mutated(good, (d) => delete d.positions[ORB_RUN_ENTITY.player]), [
      `positions.${ORB_RUN_ENTITY.player}`,
    ]);
    await assertRefused(simulation, mutated(good, (d) => (d.positions.entity_ghost = [0, 0, 0])), ["positions.entity_ghost"]);
    await assertRefused(simulation, mutated(good, (d) => delete d.scripts[ORB_RUN_ENTITY.manager]), [MANAGER]);
    await assertRefused(simulation, mutated(good, (d) => (d.scripts.entity_ghost = { collected: true })), [
      "scripts.entity_ghost",
    ]);
    // Several problems are all reported, not just the first.
    const many = await assertRefused(
      simulation,
      mutated(good, (d) => {
        d.schemaVersion = 7;
        d.step = -2;
        d.extra = 1;
      }),
      ["extra", "schemaVersion", "step"],
    );
    assert.equal(many.length, 3);
  } finally {
    await simulation.dispose();
  }
});

test("hostile positions: not numbers, outside the arena, off the ground, or entities that must stay put", async () => {
  const good = await midRunSave();
  const simulation = await startOrbRunSimulation();
  const player = `positions.${ORB_RUN_ENTITY.player}`;
  try {
    for (const bad of [[1, 2], "0,0,0", [1, "2", 3], [1, null, 3], [1, 0.5, Number.POSITIVE_INFINITY], { x: 1 }, null]) {
      await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.player] = bad)), [player]);
    }
    // Arena half extent is 5.5 in the shipped rules.
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.player] = [5.6, 0.5, 0])), [player]);
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.player] = [0, 0.5, -600])), [player]);
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.player] = [0, 40, 0])), [player]);
    // The edge itself is fine.
    assert.deepEqual(
      validateOrbRunSave(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.player] = [5.5, 0.5, -5.5]))),
      [],
    );
    // The exit pad and the camera never move; a waiting orb sits where it was authored.
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.exit] = [0, 0.05, 0])), [
      `positions.${ORB_RUN_ENTITY.exit}`,
    ]);
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.camera][1] += 1)), [
      `positions.${ORB_RUN_ENTITY.camera}`,
    ]);
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.orbC][0] += 0.01)), [
      `positions.${ORB_RUN_ENTITY.orbC}`,
    ]);
    // A collected orb is stowed; a stowed orb that the script says is waiting, and the reverse, are lies.
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.orbA][1] = 0.5)), [
      `positions.${ORB_RUN_ENTITY.orbA}`,
    ]);
    await assertRefused(simulation, mutated(good, (d) => (d.positions[ORB_RUN_ENTITY.orbC][1] = -10)), [
      `positions.${ORB_RUN_ENTITY.orbC}`,
    ]);
  } finally {
    await simulation.dispose();
  }
});

test("hostile script states: each script's own rules still apply, and the story must agree across scripts", async () => {
  const good = await midRunSave();
  const simulation = await startOrbRunSimulation();
  const orbA = `scripts.${ORB_RUN_ENTITY.orbA}`;
  const playerScript = `scripts.${ORB_RUN_ENTITY.player}`;
  try {
    // Per-script rules (the engine's validateRestoreState): reported under the script's path.
    await assertRefused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.orbA].collected = "yes")), [orbA]);
    await assertRefused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.player].distanceTravelled = -1)), [
      playerScript,
    ]);
    await assertRefused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.manager].status = "cheating")), [
      MANAGER,
    ]);
    await assertRefused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.manager] = "won")), [MANAGER]);
    // Cross-script story. "Won" with an empty bag of orbs.
    await assertRefused(
      simulation,
      mutated(good, (d) => {
        const m = d.scripts[ORB_RUN_ENTITY.manager];
        m.status = "won";
        m.exitUnlocked = false;
        m.collectedOrbIds = [];
        m.collectedCount = 0;
        d.scripts[ORB_RUN_ENTITY.player].finished = true;
        for (const id of [ORB_RUN_ENTITY.orbA, ORB_RUN_ENTITY.orbB]) d.scripts[id].collected = false;
        d.positions[ORB_RUN_ENTITY.orbA][1] = 0.5;
        d.positions[ORB_RUN_ENTITY.orbB][1] = 0.5;
      }),
      // (slice 27: a "won" save with the player mid-arena also fails the exit rule)
      [`positions.${ORB_RUN_ENTITY.player}`, `${MANAGER}.status`, `${MANAGER}.status`],
    );
    // Won before the exit was unlocked.
    await assertRefused(
      simulation,
      mutated(good, (d) => {
        d.scripts[ORB_RUN_ENTITY.manager].status = "won";
        d.scripts[ORB_RUN_ENTITY.player].finished = true;
      }),
      [`positions.${ORB_RUN_ENTITY.player}`, `${MANAGER}.status`, `${MANAGER}.status`],
    );
    // The clock: still playing past the limit, or lost with time to spare.
    await assertRefused(
      simulation,
      mutated(good, (d) => {
        // remainingSeconds follows the edited clock, so only the story ("still playing past the limit") is wrong.
        d.scripts[ORB_RUN_ENTITY.manager].elapsedSeconds = 20;
        d.scripts[ORB_RUN_ENTITY.manager].remainingSeconds = 0;
      }),
      [`${MANAGER}.elapsedSeconds`],
    );
    await assertRefused(
      simulation,
      mutated(good, (d) => {
        d.scripts[ORB_RUN_ENTITY.manager].status = "lost";
        d.scripts[ORB_RUN_ENTITY.player].finished = true;
      }),
      [`${MANAGER}.elapsedSeconds`],
    );
    // Orbs and manager disagree.
    await assertRefused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.orbC].collected = true)), [
      `scripts.${ORB_RUN_ENTITY.orbC}.collected`,
      `positions.${ORB_RUN_ENTITY.orbC}`,
    ]);
    await assertRefused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.orbA].collected = false)), [
      `${orbA}.collected`,
      `positions.${ORB_RUN_ENTITY.orbA}`,
    ]);
    // A player who is frozen in a running game, or free in a finished one.
    await assertRefused(simulation, mutated(good, (d) => (d.scripts[ORB_RUN_ENTITY.player].finished = true)), [
      `${playerScript}.finished`,
    ]);
  } finally {
    await simulation.dispose();
  }
});

/** The shipped level plus a wall authored through the typed command bus. */
function withWall(centre: { x: number; z: number }, size: { width: number; depth: number }): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  const result = bus.execute({
    requestId: "wall-save",
    command: "entity.create",
    expectedProjectRevision: bus.revision,
    payload: {
      sceneId: ORB_RUN_SCENE_ID,
      entity: { id: "wall-save", name: "Wall", components: orbRunWallComponents(centre, size) as ComponentMap },
    },
  });
  assert.equal(result.ok, true);
  return bus.snapshot().project;
}

test("a save from the open level cannot put the player inside a wall of this level", async () => {
  // The open-level save has the player at (4, 0.5, -4) after the first two stops... use a pillar right on it.
  const openSave = await midRunSave();
  const [px, , pz] = openSave.positions[ORB_RUN_ENTITY.player]!;
  const walled = withWall({ x: px, z: pz }, { width: 1.5, depth: 1.5 });
  const simulation = await startOrbRunSimulation(walled);
  try {
    await assertRefused(simulation, openSave, [`positions.${ORB_RUN_ENTITY.player}`]);
    // Touching the face is legal (0.4 m from the 0.75 m half width), 1 cm inside is not.
    const face = mutated(openSave, (d) => (d.positions[ORB_RUN_ENTITY.player] = [px + 0.75 + 0.4, 0.5, pz]));
    assert.deepEqual(validateOrbRunSave(simulation, face), []);
    const inside = mutated(openSave, (d) => (d.positions[ORB_RUN_ENTITY.player] = [px + 0.75 + 0.39, 0.5, pz]));
    assert.deepEqual(paths(validateOrbRunSave(simulation, inside)), [`positions.${ORB_RUN_ENTITY.player}`]);
  } finally {
    await simulation.dispose();
  }
});

test("a save that fails half way is rolled back: positions and scripts are put back as they were", async () => {
  const good = await midRunSave();
  const simulation = await startOrbRunSimulation();
  try {
    simulation.advance(5);
    const before = JSON.stringify(captureOrbRunSave(simulation));
    const original = simulation.restoreScript.bind(simulation);
    let calls = 0;
    simulation.restoreScript = async (entityId, state) => {
      calls += 1;
      // The second script of the save fails after the positions and the first script were already applied.
      if (calls === 2) throw new Error("disk full");
      return original(entityId, state);
    };
    await assert.rejects(restoreOrbRunSave(simulation, good), /disk full/);
    assert.ok(calls > 2, "the rollback restored the scripts again");
    assert.equal(JSON.stringify(captureOrbRunSave(simulation)), before);
    // And the game is still playable afterwards.
    simulation.restoreScript = original;
    await restoreOrbRunSave(simulation, good);
    assert.equal(summarizeOrbRun(simulation).collectedCount, 2);
  } finally {
    await simulation.dispose();
  }
});
