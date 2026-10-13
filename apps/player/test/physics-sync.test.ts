import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { applyPhysicsStateToObject, type PhysicsSyncState } from "../src/physics-sync.js";

const identityAt = (x: number, y: number, z: number): PhysicsSyncState => ({
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
});

test("a character keeps the yaw root motion applied; only its position follows physics", () => {
  const object = new THREE.Object3D();
  // Root motion applies its yaw to the render object after moving the body.
  object.rotation.y += 0.5;

  applyPhysicsStateToObject(object, identityAt(1, 2, 3), { preserveRotation: true });

  assert.deepEqual(object.position.toArray(), [1, 2, 3]);
  assert.ok(Math.abs(object.rotation.y - 0.5) < 1e-9, `yaw was ${object.rotation.y}`);
});

test("the yaw accumulates across steps for a character", () => {
  const object = new THREE.Object3D();
  for (let step = 0; step < 4; step++) {
    // Same order as the controller: sample yaw from the object, apply it, then sync from physics.
    object.rotation.y += 0.25;
    applyPhysicsStateToObject(object, identityAt(0, 0, step), { preserveRotation: true });
  }
  assert.ok(Math.abs(object.rotation.y - 1) < 1e-9, `yaw was ${object.rotation.y}`);
});

test("a body physics owns (dynamic) still takes its rotation from the simulation", () => {
  const object = new THREE.Object3D();
  object.rotation.y = 0.5;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);

  applyPhysicsStateToObject(
    object,
    { position: { x: 0, y: 1, z: 0 }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } },
    { preserveRotation: false },
  );

  assert.ok(Math.abs(object.quaternion.x - q.x) < 1e-12);
  assert.ok(Math.abs(object.quaternion.w - q.w) < 1e-12);
  assert.ok(Math.abs(object.rotation.y) < 1e-9);
  assert.deepEqual(object.position.toArray(), [0, 1, 0]);
});
