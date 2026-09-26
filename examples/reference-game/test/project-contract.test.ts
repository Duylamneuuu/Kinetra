import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseProject,
  serializeProject,
  validateProject,
  type ProjectDocument,
} from "@kinetra/project-model";

import {
  ARENA_ENTITY_CAMERA,
  ARENA_ENTITY_CORE,
  ARENA_ENTITY_ENEMY,
  ARENA_ENTITY_FLOOR,
  ARENA_ENTITY_GOAL,
  ARENA_ENTITY_MANAGER,
  ARENA_ENTITY_PLAYER,
  ARENA_ENTITY_TERMINAL,
  ARENA_PROJECT_ID,
  ARENA_SCENE_ID,
  arenaNavPositions,
  createArenaProject,
} from "../project.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../arena.kinetra.json",
);

test("arena project fixture matches the generator", async () => {
  const generated = createArenaProject();
  const again = createArenaProject();
  assert.deepEqual(generated, again);
  assert.deepEqual(validateProject(generated), []);

  const serialized = serializeProject(generated);
  assert.deepEqual(generated, again);

  const onDisk = await readFile(fixturePath, "utf8");
  assert.equal(onDisk, serialized);

  const loaded = parseProject(onDisk);
  assert.deepEqual(loaded, parseProject(serializeProject(again)));
  assertArenaCast(loaded);
});

function assertArenaCast(project: ProjectDocument): void {
  assert.equal(project.schemaVersion, 1);
  assert.equal(project.projectId, ARENA_PROJECT_ID);
  assert.equal(project.name, "Kinetra Arena");
  assert.equal(project.scenes.length, 1);

  const scene = project.scenes[0];
  assert.ok(scene);
  assert.equal(scene.id, ARENA_SCENE_ID);
  assert.equal(scene.name, "Arena Combat Room");

  const ids = scene.entities.map((entity) => entity.id);
  assert.equal(new Set(ids).size, ids.length);

  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
  assert.equal(byId.get(ARENA_ENTITY_PLAYER)?.name, "Player");
  assert.equal(byId.get(ARENA_ENTITY_ENEMY)?.name, "Enemy");
  assert.equal(byId.get(ARENA_ENTITY_TERMINAL)?.name, "SecurityConsole");
  assert.equal(byId.get(ARENA_ENTITY_CORE)?.name, "PowerCore");
  assert.equal(byId.get(ARENA_ENTITY_GOAL)?.name, "Goal");
  assert.equal(byId.get(ARENA_ENTITY_MANAGER)?.name, "ArenaManager");
  assert.equal(byId.get(ARENA_ENTITY_CAMERA)?.name, "MainCamera");

  assert.deepEqual(byId.get(ARENA_ENTITY_PLAYER)?.components.Transform, {
    position: [-5, 0.5, -5],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  assert.equal(scriptId(byId.get(ARENA_ENTITY_PLAYER)), "ArenaPlayerController");
  assert.equal(scriptId(byId.get(ARENA_ENTITY_ENEMY)), "ArenaEnemyController");
  assert.equal(scriptId(byId.get(ARENA_ENTITY_MANAGER)), "ArenaGameManager");

  const floor = byId.get(ARENA_ENTITY_FLOOR);
  const nav = floor?.components.NavMesh;
  assert.ok(nav && typeof nav === "object" && !Array.isArray(nav));
  assert.deepEqual(
    "positions" in nav ? nav.positions : undefined,
    arenaNavPositions,
  );
}

function scriptId(entity: ProjectDocument["scenes"][number]["entities"][number] | undefined): unknown {
  const script = entity?.components.Script;
  if (typeof script !== "object" || script === null || Array.isArray(script)) {
    return undefined;
  }
  return "scriptId" in script ? script.scriptId : undefined;
}
