import assert from "node:assert/strict";
import test from "node:test";

import { RecastNavMesh } from "../src/index.js";

/**
 * Two 6x6 floors side by side: the left at y = 0, the right raised by `stepHeight`, joined by a
 * vertical riser quad. The riser is too steep to walk, so a path from left to right only exists
 * when the agent is allowed to climb the step.
 */
function steppedFloors(stepHeight: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const floor = (x0: number, z0: number, x1: number, z1: number, y: number): void => {
    const base = positions.length / 3;
    positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  floor(0, 0, 6, 6, 0);
  floor(6, 0, 12, 6, stepHeight);
  // Riser at x = 6 (facing -x); steep, so Recast marks it unwalkable.
  const base = positions.length / 3;
  positions.push(6, 0, 0, 6, 0, 6, 6, stepHeight, 6, 6, stepHeight, 0);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return { positions, indices };
}

const AGENT = { cellSize: 0.2, cellHeight: 0.2, agentHeight: 1, agentRadius: 0, agentMaxSlope: 45 } as const;

test("a step exactly as tall as agentMaxClimb is climbable (0.6 / 0.2 is 3 cells, not 2.9999999999999996 -> 2)", async () => {
  const mesh = await RecastNavMesh.bake({ ...steppedFloors(0.6), ...AGENT, agentMaxClimb: 0.6 });
  try {
    const path = mesh.computePath({ x: 2, y: 0, z: 3 }, { x: 10, y: 0.6, z: 3 });
    assert.equal(path.status, "complete");
    assert.equal(path.success, true);
  } finally {
    mesh.dispose();
  }
});

test("a step taller than agentMaxClimb stays blocked", async () => {
  const mesh = await RecastNavMesh.bake({ ...steppedFloors(0.6), ...AGENT, agentMaxClimb: 0.4 });
  try {
    const path = mesh.computePath({ x: 2, y: 0, z: 3 }, { x: 10, y: 0.6, z: 3 });
    assert.notEqual(path.status, "complete");
  } finally {
    mesh.dispose();
  }
});
