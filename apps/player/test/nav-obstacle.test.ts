import assert from "node:assert/strict";
import test from "node:test";

import { parseNavObstacle, parseObstacleId } from "../src/nav-obstacle.js";

test("parseNavObstacle accepts a cylinder and a box and rejects a bad shape", () => {
  assert.deepEqual(
    parseNavObstacle({ type: "cylinder", position: [0, 1, 2], radius: 1.2, height: 2 }),
    { type: "cylinder", position: [0, 1, 2], radius: 1.2, height: 2 },
  );
  assert.deepEqual(
    parseNavObstacle({
      type: "box",
      position: [0, 0, 0],
      halfExtents: [0.4, 1, 3],
      angle: 0,
    }),
    { type: "box", position: [0, 0, 0], halfExtents: [0.4, 1, 3], angle: 0 },
  );
  assert.throws(() => parseNavObstacle(null), TypeError);
  assert.throws(() => parseNavObstacle({ type: "mesh", position: [0, 0, 0] }), /"cylinder" or "box"/);
  assert.throws(() => parseNavObstacle({ type: "cylinder", position: [0, 0], radius: 1, height: 1 }), /position/);
  assert.throws(() => parseNavObstacle({ type: "box", position: [0, 0, 0], halfExtents: [1, 1, 1] }), /angle/);
});

test("parseObstacleId requires a non-empty string", () => {
  assert.equal(parseObstacleId("1"), "1");
  assert.throws(() => parseObstacleId(""), TypeError);
  assert.throws(() => parseObstacleId(1), TypeError);
});
