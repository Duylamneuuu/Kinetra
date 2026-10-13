import assert from "node:assert/strict";
import test from "node:test";

import { buildNavBakeOptions } from "../src/nav-bake-input.js";

const positions = [0, 0, 0, 1, 0, 0, 0, 0, 1];
const indices = [0, 1, 2];

test("buildNavBakeOptions merges config around the validated geometry", () => {
  const options = buildNavBakeOptions({ positions, indices, config: { cs: 0.3, ch: 0.2 } });
  assert.deepEqual(options, { cs: 0.3, ch: 0.2, positions, indices });
});

test("buildNavBakeOptions: geometry wins over positions/indices keys smuggled into config", () => {
  const options = buildNavBakeOptions({
    positions,
    indices,
    config: { positions: [9, 9, 9], indices: [7, 7, 7], cs: 0.5 },
  });
  assert.equal(options.positions, positions);
  assert.equal(options.indices, indices);
  assert.equal(options.cs, 0.5);
});

test("buildNavBakeOptions rejects a request without geometry buffers", () => {
  assert.throws(
    () => buildNavBakeOptions({ indices }),
    /requires positions and indices geometry buffers/,
  );
  assert.throws(
    () => buildNavBakeOptions({ positions }),
    /requires positions and indices geometry buffers/,
  );
  // Geometry smuggled in through config must not satisfy the requirement either.
  assert.throws(
    () => buildNavBakeOptions({ config: { positions, indices } }),
    /requires positions and indices geometry buffers/,
  );
});

test("buildNavBakeOptions ignores a non-object config", () => {
  assert.deepEqual(buildNavBakeOptions({ positions, indices }), { positions, indices });
  assert.deepEqual(
    buildNavBakeOptions({ positions, indices, config: [1, 2, 3] as unknown as Record<string, unknown> }),
    { positions, indices },
  );
  assert.deepEqual(
    buildNavBakeOptions({ positions, indices, config: null as unknown as Record<string, unknown> }),
    { positions, indices },
  );
});
