import assert from "node:assert/strict";
import test from "node:test";

import { RecastNavMesh } from "../src/index.js";

const INDICES = [0, 2, 1, 0, 3, 2];

test("bake rejects a sparse positions array (holes are not finite numbers)", async () => {
  // Array.prototype.every skips holes, so this used to pass validation and reach Recast as NaN.
  const sparse: number[] = [];
  sparse[0] = 0;
  sparse[1] = 0;
  sparse[2] = 0;
  sparse[3] = 6;
  sparse[4] = 0;
  sparse[5] = 0;
  // sparse[6..8] left as holes
  sparse[9] = 0;
  sparse[10] = 0;
  sparse[11] = 6;
  assert.equal(sparse.length, 12);
  assert.equal(3 in sparse, true);
  assert.equal(7 in sparse, false);
  await assert.rejects(
    RecastNavMesh.bake({ positions: sparse, indices: INDICES }),
    (error: unknown) => error instanceof RangeError && /positions/.test(error.message),
  );
});

test("bake still accepts a dense quad", async () => {
  const mesh = await RecastNavMesh.bake({
    positions: [0, 0, 0, 6, 0, 0, 6, 0, 6, 0, 0, 6],
    indices: INDICES,
  });
  try {
    assert.equal(mesh.computePath({ x: 1, y: 0, z: 1 }, { x: 5, y: 0, z: 5 }).success, true);
  } finally {
    mesh.dispose();
  }
});
