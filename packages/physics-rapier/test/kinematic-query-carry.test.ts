import assert from "node:assert/strict";
import test from "node:test";

import { RapierPhysicsWorld } from "../src/index.js";

async function build(): Promise<RapierPhysicsWorld> {
  const world = await RapierPhysicsWorld.create();
  world.addKinematicBody({
    id: "platform",
    position: { x: 0, y: 0, z: 0 },
    shape: "box",
    halfExtents: { x: 5, y: 0.5, z: 5 },
  });
  world.addDynamicBody({
    id: "crate",
    position: { x: 0, y: 1.01, z: 0 },
    shape: "box",
    halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
    friction: 1,
  });
  for (let i = 0; i < 30; i++) world.step();
  return world;
}

function probe(world: RapierPhysicsWorld): void {
  world.raycast({ origin: { x: 20, y: 5, z: 20 }, direction: { x: 0, y: -1, z: 0 } });
  world.shapeCast({
    origin: { x: 20, y: 5, z: 20 },
    direction: { x: 0, y: -1, z: 0 },
    shape: { type: "sphere", radius: 0.1 },
  });
}

function run(
  world: RapierPhysicsWorld,
  queryBeforeStep: boolean,
): { platformVx: number; crateX: number } {
  let platformVx = 0;
  for (let i = 1; i <= 30; i++) {
    world.moveKinematicBody("platform", { x: 0.05 * i, y: 0, z: 0 });
    // A query between the move and the next step must not swallow the move.
    if (queryBeforeStep) probe(world);
    world.step();
    platformVx = world.state("platform").linearVelocity.x;
  }
  return { platformVx, crateX: world.state("crate").position.x };
}

test("a query between moveKinematicBody and step does not change the platform velocity or carry", async () => {
  const control = run(await build(), false);
  const queried = run(await build(), true);
  assert.ok(control.platformVx > 2.9, "control platform must have a derived velocity of ~3 m/s");
  assert.ok(
    Math.abs(queried.platformVx - control.platformVx) < 1e-3,
    `platform velocity ${queried.platformVx} vs ${control.platformVx}`,
  );
  assert.ok(control.crateX > 0.5, "control crate rides the platform");
  assert.ok(queried.crateX > 0.5, "queried crate rides the platform too");
  assert.ok(
    Math.abs(queried.crateX - control.crateX) < 0.2,
    `crate x ${queried.crateX} vs ${control.crateX}`,
  );
});

test("several moveKinematicBody calls before a step use the last target and the original start", async () => {
  const a = await build();
  a.moveKinematicBody("platform", { x: 0.2, y: 0, z: 0 });
  probe(a);
  a.moveKinematicBody("platform", { x: 0.5, y: 0, z: 0 });
  a.step();
  const b = await build();
  b.moveKinematicBody("platform", { x: 0.5, y: 0, z: 0 });
  b.step();
  assert.equal(a.state("platform").linearVelocity.x, b.state("platform").linearVelocity.x);
  assert.equal(a.state("platform").position.x, b.state("platform").position.x);
});

test("advance() after a query also carries the move", async () => {
  const a = await build();
  a.moveKinematicBody("platform", { x: 0.5, y: 0, z: 0 });
  probe(a);
  a.advance(1 / 60);
  const b = await build();
  b.moveKinematicBody("platform", { x: 0.5, y: 0, z: 0 });
  b.advance(1 / 60);
  assert.equal(a.state("platform").linearVelocity.x, b.state("platform").linearVelocity.x);
});

// Follow-up to #356 (issue #367): pending-move bookkeeping edge cases.

test("removing a body with a pending kinematic move does not break the next step or other bodies", async () => {
  const w = await build();
  w.moveKinematicBody("platform", { x: 3, y: 0, z: 0 });
  probe(w);
  w.remove("platform");
  assert.doesNotThrow(() => w.step());
  assert.throws(() => w.state("platform"));
  assert.ok(Number.isFinite(w.state("crate").position.y));
  // Re-adding the same id must not inherit the removed body's pending move.
  w.addKinematicBody({ id: "platform", position: { x: 10, y: 0, z: 0 }, shape: "box", halfExtents: { x: 1, y: 0.5, z: 1 } });
  w.step();
  assert.ok(Math.abs(w.state("platform").position.x - 10) < 1e-6);
  assert.ok(Math.abs(w.state("platform").linearVelocity.x) < 1e-6);
});

test("moveCharacter after moveKinematicBody on the same body wins; the stale move is not replayed", async () => {
  const w = await build();
  w.moveKinematicBody("platform", { x: 3, y: 0, z: 0 });
  const result = w.moveCharacter("platform", { x: 0.5, y: 0, z: 0 });
  assert.ok(Math.abs(result.actual.x - 0.5) < 1e-3, `character displacement ${result.actual.x}`);
  const afterMove = w.state("platform").position.x;
  w.step();
  const x = w.state("platform").position.x;
  assert.ok(
    Math.abs(x - afterMove) < 0.05,
    `platform ended at ${x} after moveCharacter left it at ${afterMove}: the earlier move was replayed`,
  );
});

test("advance() that runs no fixed step keeps the pending move for the step that does run", async () => {
  const a = await build();
  a.moveKinematicBody("platform", { x: 0.5, y: 0, z: 0 });
  assert.equal(a.advance(1 / 240), 0, "a quarter of a fixed step must not run a step");
  probe(a);
  assert.equal(a.advance(1 / 240), 0);
  assert.equal(a.stats().fixedSteps, 30, "no fixed step ran yet (the build() warm-up ran 30)");
  assert.equal(a.advance(1 / 60), 1);
  const b = await build();
  b.moveKinematicBody("platform", { x: 0.5, y: 0, z: 0 });
  b.step();
  assert.equal(a.state("platform").position.x, b.state("platform").position.x);
  assert.equal(a.state("platform").linearVelocity.x, b.state("platform").linearVelocity.x);
});

test("setBodyTranslation after a pending kinematic move wins (no stale move replayed)", async () => {
  const w = await build();
  w.moveKinematicBody("platform", { x: 3, y: 0, z: 0 });
  probe(w);
  w.setBodyTranslation("platform", { x: -2, y: 0, z: 0 }, true);
  w.step();
  assert.ok(Math.abs(w.state("platform").position.x - -2) < 1e-6);
});
