import assert from "node:assert/strict";
import test from "node:test";

import { parseRaycastParams, parseShapeCastParams } from "../src/physics-query.js";

const down = {
  origin: { x: 0, y: 2, z: 0 },
  direction: { x: 0, y: -1, z: 0 },
};

test("parseRaycastParams keeps a finite query and its filters", () => {
  const query = parseRaycastParams({
    ...down,
    layers: [0, 2],
    excludeEntityIds: ["hero"],
    maxDistance: 8,
  });
  assert.deepEqual(query, {
    origin: { x: 0, y: 2, z: 0 },
    direction: { x: 0, y: -1, z: 0 },
    layers: [0, 2],
    excludeEntityIds: ["hero"],
    maxDistance: 8,
  });
});

test("parseShapeCastParams accepts sphere, box and capsule", () => {
  const sphere = parseShapeCastParams({
    ...down,
    shape: { type: "sphere", radius: 0.5 },
  });
  assert.equal(sphere.shape.type, "sphere");
  const box = parseShapeCastParams({
    ...down,
    shape: { type: "box", halfExtents: { x: 1, y: 2, z: 3 } },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  assert.deepEqual(box.shape, { type: "box", halfExtents: { x: 1, y: 2, z: 3 } });
  assert.equal(box.rotation?.w, 1);
  const capsule = parseShapeCastParams({
    ...down,
    shape: { type: "capsule", halfHeight: 0.4, radius: 0.2 },
  });
  assert.deepEqual(capsule.shape, { type: "capsule", halfHeight: 0.4, radius: 0.2 });
});

test("physics query parsers reject a payload that is not the query shape", () => {
  assert.throws(() => parseRaycastParams({ direction: down.direction }), TypeError);
  assert.throws(() => parseRaycastParams({ ...down, origin: { x: 0, y: Number.NaN, z: 0 } }), TypeError);
  assert.throws(() => parseRaycastParams({ ...down, layers: "0" }), TypeError);
  assert.throws(() => parseRaycastParams({ ...down, excludeEntityIds: [1] }), TypeError);
  assert.throws(() => parseShapeCastParams({ ...down }), TypeError);
  assert.throws(() => parseShapeCastParams({ ...down, shape: { type: "plane" } }), TypeError);
  assert.throws(
    () => parseShapeCastParams({ ...down, shape: { type: "box", halfExtents: [1, 1, 1] } }),
    TypeError,
  );
  assert.throws(
    () =>
      parseShapeCastParams({
        ...down,
        shape: { type: "sphere", radius: 1 },
        rotation: { x: 0, y: 0, z: 0 },
      }),
    TypeError,
  );
});
