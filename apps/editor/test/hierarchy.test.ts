import assert from "node:assert/strict";
import test from "node:test";

import type { EntityDefinition, SceneDefinition } from "@kinetra/project-model";

import { buildHierarchy } from "../src/index.js";

function entity(id: string, parentId?: string, components: Record<string, never> = {}): EntityDefinition {
  return { id, name: id.toUpperCase(), ...(parentId !== undefined ? { parentId } : {}), components };
}

function scene(entities: EntityDefinition[]): SceneDefinition {
  return { id: "scene_main", name: "Main", entities };
}

test("flattens depth-first, siblings in document order, children right after their parent", () => {
  const rows = buildHierarchy(
    scene([
      entity("a"),
      entity("b"),
      entity("a2", "a"),
      entity("a1", "a"),
      entity("a1x", "a1"),
      entity("b1", "b"),
    ]),
  );
  assert.deepEqual(
    rows.map((row) => [row.entityId, row.depth]),
    [
      ["a", 0],
      ["a2", 1],
      ["a1", 1],
      ["a1x", 2],
      ["b", 0],
      ["b1", 1],
    ],
  );
  assert.equal(rows.find((row) => row.entityId === "a")!.childCount, 2);
  assert.equal(rows.find((row) => row.entityId === "a1x")!.parentId, "a1");
  assert.equal("parentId" in rows.find((row) => row.entityId === "a")!, false);
  assert.ok(rows.every((row) => row.detached === false));
});

test("lists component names in code-unit order", () => {
  const rows = buildHierarchy(
    scene([{ id: "a", name: "A", components: { Zeta: {}, Alpha: {}, alpha: {}, Beta: {} } }]),
  );
  assert.deepEqual(rows[0]!.components, ["Alpha", "Beta", "Zeta", "alpha"]);
});

test("an entity whose parent is not in the scene is shown as a detached root, not hidden", () => {
  const rows = buildHierarchy(scene([entity("a"), entity("lost", "ghost"), entity("lost-child", "lost")]));
  assert.deepEqual(
    rows.map((row) => [row.entityId, row.depth, row.detached]),
    [
      ["a", 0, false],
      ["lost", 0, true],
      ["lost-child", 1, false],
    ],
  );
});

test("a parent cycle and a self-parent still show every entity exactly once", () => {
  const rows = buildHierarchy(
    scene([entity("x", "y"), entity("y", "x"), entity("self", "self"), entity("ok")]),
  );
  assert.deepEqual(rows.map((row) => row.entityId).sort(), ["ok", "self", "x", "y"]);
  assert.equal(rows.find((row) => row.entityId === "self")!.detached, true);
  assert.equal(rows.find((row) => row.entityId === "x")!.detached, true);
  assert.equal(rows.find((row) => row.entityId === "ok")!.detached, false);
});

test("an empty scene has no rows", () => {
  assert.deepEqual(buildHierarchy(scene([])), []);
});

test("a very deep chain does not overflow the stack", () => {
  const depth = 20_000;
  const entities: EntityDefinition[] = [entity("n0")];
  for (let index = 1; index < depth; index += 1) {
    entities.push(entity(`n${index}`, `n${index - 1}`));
  }
  const rows = buildHierarchy(scene(entities));
  assert.equal(rows.length, depth);
  assert.equal(rows.at(-1)!.depth, depth - 1);
});

test("property: random forests (with dangling parents) list every entity once, parents before children", () => {
  let seed = 0x2f6e2b1;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let round = 0; round < 200; round += 1) {
    const count = 1 + Math.floor(random() * 30);
    const entities: EntityDefinition[] = [];
    for (let index = 0; index < count; index += 1) {
      const roll = random();
      const parent =
        roll < 0.3 ? undefined : roll < 0.9 ? `e${Math.floor(random() * count)}` : "missing";
      entities.push(entity(`e${index}`, parent));
    }
    const rows = buildHierarchy(scene(entities));
    assert.deepEqual(
      rows.map((row) => row.entityId).sort(),
      entities.map((candidate) => candidate.id).sort(),
      `round ${round}: every entity exactly once`,
    );
    const position = new Map(rows.map((row, index) => [row.entityId, index]));
    for (const row of rows) {
      if (row.depth > 0) {
        assert.ok(row.parentId !== undefined);
        assert.ok(position.get(row.parentId!)! < position.get(row.entityId)!, "parent precedes child");
      }
    }
  }
});
