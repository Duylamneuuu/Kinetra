import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap } from "@kinetra/project-model";

import {
  ORB_RUN_ACTION,
  ORB_RUN_DEFAULT_RULES,
  ORB_RUN_ENTITY,
  ORB_RUN_PLAYER_RADIUS,
  ORB_RUN_SCENE_ID,
  ORB_RUN_SLOW_ZONE_COMPONENT,
  ORB_RUN_WALL_COMPONENT,
  createOrbRunProject,
  orbRunSlowZoneComponents,
  orbRunWallComponents,
  OrbRunSaveError,
  captureOrbRunSave,
  restoreOrbRunSave,
  startOrbRunSimulation,
  summarizeOrbRun,
  type HeadlessSceneSimulation,
} from "../src/index.js";

/**
 * Slice 39 (#437 item 3): what a running game sees of authoring done after it started.
 *
 * Design under test: a simulation reads the project once, when it is built (`HeadlessSceneSimulation` clones it and
 * `createOrbRunScriptRegistry` reads walls and slow zones up front). A wall or mud patch created -- or a zone patched --
 * on the command bus *after* start is therefore invisible to the live run, and visible to the next run started from a
 * fresh snapshot. These tests pin that contract on both sides, so a future "live" authoring bridge is a deliberate
 * change (and the engine request "rebuild scripts on authoring change" stays in LOG.md), not an accident.
 */

const STEP_METRES = ORB_RUN_DEFAULT_RULES.playerSpeed / 30;
const START_X = -4;
const START_Z = -4;

const MUD = { id: "late-mud", centre: { x: START_X, z: START_Z }, radius: 3, speedMultiplier: 0.4 };

function addMud(bus: CommandBus): void {
  const result = bus.execute({
    requestId: "late-mud",
    command: "entity.create",
    expectedProjectRevision: bus.revision,
    payload: {
      sceneId: ORB_RUN_SCENE_ID,
      entity: {
        id: MUD.id,
        name: "Late mud",
        components: orbRunSlowZoneComponents(MUD.centre, MUD) as ComponentMap,
      },
    },
  });
  assert.equal(result.ok, true);
}

/** A wall 1 m wide centred 2 m east of the start: its west face is at x = -2.5, so the runner (radius 0.4) stops at x = -2.9. */
const WALL = { id: "late-wall", centre: { x: -2, z: START_Z }, width: 1, depth: 4 };
const WALL_WEST_FACE = WALL.centre.x - WALL.width / 2;
const STOP_X = WALL_WEST_FACE - ORB_RUN_PLAYER_RADIUS;

function addWall(bus: CommandBus): void {
  const result = bus.execute({
    requestId: "late-wall",
    command: "entity.create",
    expectedProjectRevision: bus.revision,
    payload: {
      sceneId: ORB_RUN_SCENE_ID,
      entity: {
        id: WALL.id,
        name: "Late wall",
        components: orbRunWallComponents(WALL.centre, { width: WALL.width, depth: WALL.depth }) as ComponentMap,
      },
    },
  });
  assert.equal(result.ok, true);
}

function playerX(simulation: HeadlessSceneSimulation): number {
  return summarizeOrbRun(simulation).player[0];
}

async function runRight(simulation: HeadlessSceneSimulation, steps: number): Promise<number> {
  try {
    simulation.setAction(ORB_RUN_ACTION.moveRight, 1);
    simulation.advance(steps);
    return playerX(simulation);
  } finally {
    simulation.releaseAllActions();
  }
}

test("mud created after start does not slow the live run; the next run started from a new snapshot is slowed", async () => {
  const bus = new CommandBus(createOrbRunProject());
  const live = await startOrbRunSimulation(bus.snapshot().project);
  try {
    addMud(bus);
    assert.equal(live.getAuthoredComponent(MUD.id, ORB_RUN_SLOW_ZONE_COMPONENT), undefined, "the live run never saw the entity");

    const liveX = await runRight(live, 30);
    assert.ok(Math.abs(liveX - (START_X + 30 * STEP_METRES)) < 1e-9, `live run moved to ${liveX}`);

    const restarted = await startOrbRunSimulation(bus.snapshot().project);
    try {
      assert.notEqual(restarted.getAuthoredComponent(MUD.id, ORB_RUN_SLOW_ZONE_COMPONENT), undefined);
      const restartedX = await runRight(restarted, 30);
      assert.ok(
        Math.abs(restartedX - (START_X + 30 * STEP_METRES * MUD.speedMultiplier)) < 1e-9,
        `restarted run moved to ${restartedX}`,
      );
      assert.ok(restartedX < liveX);
    } finally {
      await restarted.dispose();
    }
  } finally {
    await live.dispose();
  }
});

test("a zone patched after start keeps its start-time speed in the live run, and the new value applies to the next run", async () => {
  const bus = new CommandBus(createOrbRunProject());
  addMud(bus);
  const live = await startOrbRunSimulation(bus.snapshot().project);
  try {
    const patched = bus.execute({
      requestId: "mud-gone",
      command: "component.patch",
      payload: { entityId: MUD.id, component: ORB_RUN_SLOW_ZONE_COMPONENT, patch: { speedMultiplier: 1 } as never },
    });
    assert.equal(patched.ok, true);

    const liveX = await runRight(live, 30);
    assert.ok(
      Math.abs(liveX - (START_X + 30 * STEP_METRES * MUD.speedMultiplier)) < 1e-9,
      `the live run still wades through the mud: ${liveX}`,
    );

    const restarted = await startOrbRunSimulation(bus.snapshot().project);
    try {
      const restartedX = await runRight(restarted, 30);
      assert.ok(Math.abs(restartedX - (START_X + 30 * STEP_METRES)) < 1e-9, `the patched zone is harmless now: ${restartedX}`);
    } finally {
      await restarted.dispose();
    }
  } finally {
    await live.dispose();
  }
});

test("a wall created after start does not block the live runner; a run started from a new snapshot stops at its face", async () => {
  const bus = new CommandBus(createOrbRunProject());
  const live = await startOrbRunSimulation(bus.snapshot().project);
  try {
    addWall(bus);
    assert.equal(live.getAuthoredComponent(WALL.id, ORB_RUN_WALL_COMPONENT), undefined);

    // 60 steps is 8 m at 4 m/s: the runner reaches x = 4 (the arena edge), straight through where the wall now is in the project.
    const liveX = await runRight(live, 60);
    assert.ok(Math.abs(liveX - (START_X + 60 * STEP_METRES)) < 1e-9, `live run at ${liveX}`);
    assert.ok(liveX > WALL.centre.x + WALL.width / 2, "the live run walked through the late wall");

    const restarted = await startOrbRunSimulation(bus.snapshot().project);
    try {
      const restartedX = await runRight(restarted, 60);
      assert.ok(restartedX <= STOP_X + 1e-9, `restarted run at ${restartedX}, wall face at ${WALL_WEST_FACE}`);
      assert.ok(restartedX > STOP_X - STEP_METRES - 1e-9, "and it did get right up to the wall");
    } finally {
      await restarted.dispose();
    }
  } finally {
    await live.dispose();
  }
});

test("editing the project after start never touches the project the live run holds (it works on a clone)", async () => {
  const bus = new CommandBus(createOrbRunProject());
  const project = bus.snapshot().project;
  const before = structuredClone(project);
  const live = await startOrbRunSimulation(project);
  try {
    addWall(bus);
    addMud(bus);
    await runRight(live, 10);
    assert.deepEqual(project, before, "the document handed to the game is not mutated by the game or by later commands");
    // The command bus kept its own, newer document.
    const entityIds = bus
      .snapshot()
      .project.scenes.find((scene) => scene.id === ORB_RUN_SCENE_ID)!
      .entities.map((entity) => entity.id);
    assert.ok(entityIds.includes(WALL.id) && entityIds.includes(MUD.id));
    assert.equal(live.getAuthoredComponent(WALL.id, ORB_RUN_WALL_COMPONENT), undefined);
  } finally {
    await live.dispose();
  }
});

test("a save taken by the stale run is refused by a restart that has the late wall: the player would resume inside it", async () => {
  const bus = new CommandBus(createOrbRunProject());
  const live = await startOrbRunSimulation(bus.snapshot().project);
  try {
    addWall(bus);
    // 18 steps = 2.4 m at 4 m/s: x = -1.6, which is 0.1 m from the wall's east face (-1.5, inside the 0.4 m radius).
    const x = await runRight(live, 18);
    assert.ok(Math.abs(x - -1.6) < 1e-9, `stale run at ${x}`);
    const save = JSON.parse(JSON.stringify(captureOrbRunSave(live)));

    const restarted = await startOrbRunSimulation(bus.snapshot().project);
    try {
      const before = captureOrbRunSave(restarted);
      await assert.rejects(restoreOrbRunSave(restarted, save), (error: unknown) => {
        assert.ok(error instanceof OrbRunSaveError);
        assert.ok(error.issues.some((issue) => issue.path.includes(ORB_RUN_ENTITY.player)), JSON.stringify(error.issues));
        return true;
      });
      assert.deepEqual(captureOrbRunSave(restarted), before, "a refused save touches nothing");
    } finally {
      await restarted.dispose();
    }

    // The same save loads fine into the run that never had the wall.
    await restoreOrbRunSave(live, save);
    assert.deepEqual(captureOrbRunSave(live), save);
  } finally {
    await live.dispose();
  }
});
