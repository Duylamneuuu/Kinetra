import assert from "node:assert/strict";
import test from "node:test";

import { RecastNavMesh } from "../src/index.js";
// Internal helper: exported from navmesh.ts for unit tests, deliberately not re-exported by the package index.
import { toCells } from "../src/navmesh.js";

test("toCells ceil: a quotient a hair above an integer does not gain a whole cell (1.05 / 0.15 = 7.000000000000001)", () => {
  assert.ok(1.05 / 0.15 > 7, "the premise: the raw float quotient overshoots 7");
  assert.equal(Math.ceil(1.05 / 0.15), 8, "the premise: a bare Math.ceil would give 8");
  assert.equal(toCells(1.05, 0.15, Math.ceil), 7);
});

test("toCells floor: a quotient a hair below an integer does not lose a whole cell (0.6 / 0.2 = 2.9999999999999996)", () => {
  assert.ok(0.6 / 0.2 < 3);
  assert.equal(toCells(0.6, 0.2, Math.floor), 3);
});

test("toCells still rounds genuinely fractional quotients in the requested direction", () => {
  assert.equal(toCells(1.0, 0.3, Math.ceil), 4);
  assert.equal(toCells(1.0, 0.3, Math.floor), 3);
  assert.equal(toCells(0.31, 0.3, Math.ceil), 2);
  assert.equal(toCells(0.31, 0.3, Math.floor), 1);
  assert.equal(toCells(0.299, 0.3, Math.ceil), 1);
  assert.equal(toCells(0.299, 0.3, Math.floor), 0);
});

test("toCells is exact on whole quotients and on zero", () => {
  for (const cells of [0, 1, 2, 3, 7, 10, 64, 1000]) {
    for (const cell of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 1]) {
      assert.equal(toCells(cells * cell, cell, Math.ceil), cells, `${cells} cells of ${cell} (ceil)`);
      assert.equal(toCells(cells * cell, cell, Math.floor), cells, `${cells} cells of ${cell} (floor)`);
    }
  }
});

test("toCells property: ceil >= floor, they differ by at most one and bracket the true quotient", () => {
  // Deterministic LCG so the test never flakes.
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let i = 0; i < 500; i += 1) {
    const cell = 0.05 + rand() * 0.95;
    const length = rand() * 20;
    const ceil = toCells(length, cell, Math.ceil);
    const floor = toCells(length, cell, Math.floor);
    const quotient = length / cell;
    assert.ok(ceil >= floor);
    assert.ok(ceil - floor <= 1);
    assert.ok(floor <= quotient + 1e-6 && ceil >= quotient - 1e-6, `bracket ${length}/${cell}`);
    assert.ok(Number.isInteger(ceil) && Number.isInteger(floor));
  }
});

test("a tiny agentHeight (below Recast's 3-cell minimum) still bakes a walkable mesh instead of failing", async () => {
  const positions = [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10];
  const indices = [0, 2, 1, 0, 3, 2];
  const mesh = await RecastNavMesh.bake({ positions, indices, cellSize: 0.2, cellHeight: 0.2, agentHeight: 0.1, agentRadius: 0 });
  try {
    const path = mesh.computePath({ x: 2, y: 0, z: 2 }, { x: 8, y: 0, z: 8 });
    assert.equal(path.status, "complete");
  } finally {
    mesh.dispose();
  }
});
