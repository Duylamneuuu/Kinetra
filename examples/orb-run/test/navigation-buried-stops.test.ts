import assert from "node:assert/strict";
import test from "node:test";

import { CommandBus } from "@kinetra/command-bus";
import type { ComponentMap, ProjectDocument } from "@kinetra/project-model";

import { ORB_RUN_SCENE_ID, ORB_RUN_SCRIPT, createOrbRunProject, orbRunWallComponents } from "../src/index.js";
import { planOrbRunRoute } from "../src/navigation.js";

function positionOf(project: ProjectDocument, predicate: (entity: { id: string; name?: string; components: Record<string, unknown> }) => boolean) {
  const entity = project.scenes.find((scene) => scene.id === ORB_RUN_SCENE_ID)!.entities.find((candidate) => predicate(candidate as never))!;
  const position = (entity.components.Transform as { position: number[] }).position;
  return { id: entity.id, x: position[0]!, z: position[2]! };
}

function withWall(wall: { id: string; centre: { x: number; z: number }; width: number; depth: number }): ProjectDocument {
  const bus = new CommandBus(createOrbRunProject());
  bus.execute({
    requestId: "wall-0",
    command: "entity.create",
    expectedProjectRevision: bus.revision,
    payload: {
      sceneId: ORB_RUN_SCENE_ID,
      entity: {
        id: wall.id,
        name: `Wall ${wall.id}`,
        components: orbRunWallComponents(wall.centre, { width: wall.width, depth: wall.depth }) as ComponentMap,
      },
    },
  });
  return bus.snapshot().project;
}

test("planOrbRunRoute reports an orb buried deep inside a wall as route_blocked instead of throwing", async () => {
  const shipped = createOrbRunProject();
  const orb = positionOf(shipped, (entity) => (entity.components.Script as { scriptId?: string } | undefined)?.scriptId === ORB_RUN_SCRIPT.orb);
  // A 4 m x 4 m block centred on the orb: the nearest walkable floor is ~2 m away, outside the snap extents.
  const project = withWall({ id: "block", centre: { x: orb.x, z: orb.z }, width: 4, depth: 4 });

  const plan = await planOrbRunRoute(project);
  assert.equal(plan.ok, false);
  assert.ok(
    plan.diagnostics.some((entry) => entry.code === "route_blocked" && entry.entityId === orb.id),
    `expected route_blocked for ${orb.id}, got ${JSON.stringify(plan.diagnostics)}`,
  );
});

/** Four walls 1.2 m either side of the player: the player's 0.4 m circle fits, the 0.5 m route agent does not. */
function pocketAroundPlayer(project: ProjectDocument) {
  const player = positionOf(project, (entity) => (entity.components.Script as { scriptId?: string } | undefined)?.scriptId === ORB_RUN_SCRIPT.player);
  const walls = [
    { id: "n", centre: { x: player.x, z: player.z - 1.2 }, width: 20, depth: 1 },
    { id: "s", centre: { x: player.x, z: player.z + 1.2 }, width: 20, depth: 1 },
    { id: "e", centre: { x: player.x + 1.2, z: player.z }, width: 1, depth: 20 },
    { id: "w", centre: { x: player.x - 1.2, z: player.z }, width: 1, depth: 20 },
  ];
  const bus = new CommandBus(project);
  walls.forEach((wall, index) => {
    bus.execute({
      requestId: `pocket-${index}`,
      command: "entity.create",
      expectedProjectRevision: bus.revision,
      payload: {
        sceneId: ORB_RUN_SCENE_ID,
        entity: {
          id: wall.id,
          name: `Wall ${wall.id}`,
          components: orbRunWallComponents(wall.centre, { width: wall.width, depth: wall.depth }) as ComponentMap,
        },
      },
    });
  });
  return { player, project: bus.snapshot().project };
}

test("planOrbRunRoute reports a player walled into a pocket narrower than the route agent as route_blocked instead of throwing", async () => {
  const { player, project } = pocketAroundPlayer(createOrbRunProject());

  const plan = await planOrbRunRoute(project);
  assert.equal(plan.ok, false);
  assert.ok(
    plan.diagnostics.some((entry) => entry.code === "route_blocked" && entry.entityId === player.id),
    `expected route_blocked for the player ${player.id}, got ${JSON.stringify(plan.diagnostics)}`,
  );
});

test("planOrbRunRoute reports every stop of a level walled down to a 0.9 m strip as route_blocked", async () => {
  // Left and right walls leave a 0.9 m strip around the player (x from -4.45 to -3.55): the 0.4 m player fits, the
  // 0.5 m route agent barely does. Guards the other half of "never throws": a (near-)empty navmesh.
  const bus = new CommandBus(createOrbRunProject());
  [
    { id: "left", centre: { x: -7.45, z: 0 }, width: 6, depth: 30 },
    { id: "right", centre: { x: 1.45, z: 0 }, width: 10, depth: 30 },
  ].forEach((wall, index) => {
    bus.execute({
      requestId: `strip-${index}`,
      command: "entity.create",
      expectedProjectRevision: bus.revision,
      payload: {
        sceneId: ORB_RUN_SCENE_ID,
        entity: {
          id: wall.id,
          name: `Wall ${wall.id}`,
          components: orbRunWallComponents(wall.centre, { width: wall.width, depth: wall.depth }) as ComponentMap,
        },
      },
    });
  });

  const plan = await planOrbRunRoute(bus.snapshot().project);
  assert.equal(plan.ok, false);
  assert.ok(plan.diagnostics.length > 0);
  assert.ok(
    plan.diagnostics.every((entry) => entry.code === "route_blocked"),
    JSON.stringify(plan.diagnostics),
  );
});

test("planOrbRunRoute reports the exit buried inside a wall as route_blocked instead of throwing", async () => {
  const shipped = createOrbRunProject();
  const exit = positionOf(shipped, (entity) => entity.name === "Exit");
  const project = withWall({ id: "block", centre: { x: exit.x, z: exit.z }, width: 4, depth: 4 });

  const plan = await planOrbRunRoute(project);
  assert.equal(plan.ok, false);
  assert.ok(
    plan.diagnostics.some((entry) => entry.code === "route_blocked" && entry.entityId === exit.id),
    `expected route_blocked for ${exit.id}, got ${JSON.stringify(plan.diagnostics)}`,
  );
});
