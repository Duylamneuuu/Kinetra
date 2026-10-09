import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import {
  createPhysicsWorldFromScene,
  RapierPhysicsWorld,
} from "../src/index.js";

const ORIGIN = { x: 0, y: 0, z: 0 };
const UNIT = { x: 1, y: 1, z: 1 };

async function withWorld(
  run: (physics: RapierPhysicsWorld) => void | Promise<void>,
  options?: Parameters<typeof RapierPhysicsWorld.create>[0],
): Promise<void> {
  const physics = await RapierPhysicsWorld.create(options);
  try {
    await run(physics);
  } finally {
    physics.dispose();
  }
}

function sceneOf(entities: SceneDefinition["entities"]): SceneDefinition {
  return { id: stableId("scene", "validation"), name: "Validation", entities };
}

test("an unsupported dynamic shape is rejected without leaving an orphan rigid body", async () => {
  await withWorld((physics) => {
    assert.throws(
      () =>
        physics.addDynamicBody({
          id: "cone",
          position: ORIGIN,
          shape: "cone" as unknown as "box",
        }),
      /Unsupported dynamic body shape "cone"/,
    );
    assert.equal(physics.hasBody("cone"), false);
    assert.equal(physics.stats().bodies, 0);
    assert.equal(physics.stats().colliders, 0);
    // The id was never claimed, so a valid body can still use it.
    physics.addDynamicBody({ id: "cone", position: ORIGIN, shape: "sphere" });
    assert.equal(physics.stats().bodies, 1);
  });
});

test("fixed boxes reject non-finite positions, non-positive extents and bad materials", async () => {
  await withWorld((physics) => {
    const bad: Array<[string, Parameters<typeof physics.addFixedBox>[0]]> = [
      ["NaN position", { id: "a", position: { x: NaN, y: 0, z: 0 }, halfExtents: UNIT }],
      ["Infinity position", { id: "a", position: { x: 0, y: Infinity, z: 0 }, halfExtents: UNIT }],
      ["negative extent", { id: "a", position: ORIGIN, halfExtents: { x: -1, y: 1, z: 1 } }],
      ["zero extent", { id: "a", position: ORIGIN, halfExtents: { x: 1, y: 0, z: 1 } }],
      ["NaN extent", { id: "a", position: ORIGIN, halfExtents: { x: 1, y: 1, z: NaN } }],
      ["negative friction", { id: "a", position: ORIGIN, halfExtents: UNIT, friction: -0.1 }],
      ["NaN restitution", { id: "a", position: ORIGIN, halfExtents: UNIT, restitution: NaN }],
    ];
    for (const [label, input] of bad) {
      assert.throws(() => physics.addFixedBox(input), RangeError, label);
    }
    assert.equal(physics.stats().bodies, 0, "nothing was created by rejected calls");
    assert.deepEqual(physics.bodyIds(), []);
    physics.addFixedBox({ id: "a", position: ORIGIN, halfExtents: UNIT, friction: 0, restitution: 0 });
    assert.deepEqual(physics.bodyIds(), ["a"]);
  });
});

test("dynamic bodies reject non-finite positions and non-positive shapes, mass and bad materials", async () => {
  await withWorld((physics) => {
    const bad: Array<[string, Parameters<typeof physics.addDynamicBody>[0]]> = [
      ["NaN position", { id: "d", position: { x: NaN, y: 0, z: 0 }, shape: "sphere" }],
      ["negative radius", { id: "d", position: ORIGIN, shape: "sphere", radius: -1 }],
      ["zero radius", { id: "d", position: ORIGIN, shape: "sphere", radius: 0 }],
      ["negative capsule halfHeight", { id: "d", position: ORIGIN, shape: "capsule", halfHeight: -1 }],
      ["negative box extent", { id: "d", position: ORIGIN, shape: "box", halfExtents: { x: 1, y: -1, z: 1 } }],
      ["NaN box extent", { id: "d", position: ORIGIN, shape: "box", halfExtents: { x: NaN, y: 1, z: 1 } }],
      ["negative mass", { id: "d", position: ORIGIN, shape: "sphere", mass: -3 }],
      ["zero mass", { id: "d", position: ORIGIN, shape: "sphere", mass: 0 }],
      ["Infinity mass", { id: "d", position: ORIGIN, shape: "sphere", mass: Infinity }],
      ["NaN gravityScale", { id: "d", position: ORIGIN, shape: "sphere", gravityScale: NaN }],
      ["negative friction", { id: "d", position: ORIGIN, shape: "sphere", friction: -1 }],
      ["Infinity restitution", { id: "d", position: ORIGIN, shape: "sphere", restitution: Infinity }],
    ];
    for (const [label, input] of bad) {
      assert.throws(() => physics.addDynamicBody(input), RangeError, label);
    }
    assert.equal(physics.stats().bodies, 0);
    assert.equal(physics.stats().colliders, 0);

    // Negative gravityScale is legitimate (floating bodies) and zero mass is not.
    physics.addDynamicBody({ id: "floaty", position: { x: 0, y: 1, z: 0 }, shape: "box", gravityScale: -1 });
    physics.step(1 / 60);
    assert.ok(physics.state("floaty").linearVelocity.y > 0, "negative gravity scale rises");
  });
});

test("kinematic characters validate geometry, offset and autostep before creating anything", async () => {
  await withWorld((physics) => {
    const base = { id: "c", position: ORIGIN, halfHeight: 0.5, radius: 0.4 };
    const bad: Array<[string, Parameters<typeof physics.addKinematicCharacter>[0]]> = [
      ["NaN position", { ...base, position: { x: 0, y: NaN, z: 0 } }],
      ["zero halfHeight", { ...base, halfHeight: 0 }],
      ["negative radius", { ...base, radius: -0.4 }],
      ["NaN radius", { ...base, radius: NaN }],
      ["negative offset", { ...base, offset: -0.01 }],
      ["NaN autostepMaxHeight", { ...base, autostepMaxHeight: NaN }],
      ["negative autostepMinWidth", { ...base, autostepMinWidth: -1 }],
    ];
    for (const [label, input] of bad) {
      assert.throws(() => physics.addKinematicCharacter(input), RangeError, label);
    }
    assert.equal(physics.stats().bodies, 0);
    assert.deepEqual(physics.characterIds(), []);
    physics.addKinematicCharacter({ ...base, offset: 0, autostepMaxHeight: 0.3, autostepMinWidth: 0.2 });
    assert.deepEqual(physics.characterIds(), ["c"]);
  });
});

test("duplicate ids are rejected across body kinds without mutating the world", async () => {
  await withWorld((physics) => {
    physics.addFixedBox({ id: "x", position: ORIGIN, halfExtents: UNIT });
    assert.throws(() => physics.addDynamicBody({ id: "x", position: ORIGIN, shape: "box" }), /already exists/);
    assert.throws(
      () => physics.addKinematicCharacter({ id: "x", position: ORIGIN, halfHeight: 0.5, radius: 0.4 }),
      /already exists/,
    );
    assert.equal(physics.stats().bodies, 1);
    assert.equal(physics.stats().colliders, 1);
  });
});

test("remove drops bodies, characters and their collider ownership; unknown ids throw", async () => {
  await withWorld((physics) => {
    physics.addFixedBox({ id: "floor", position: { x: 0, y: -0.5, z: 0 }, halfExtents: { x: 5, y: 0.5, z: 5 } });
    physics.addKinematicCharacter({ id: "hero", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    assert.deepEqual(physics.characterIds(), ["hero"]);
    assert.equal(physics.layerOf("hero"), 0);

    physics.remove("hero");
    assert.equal(physics.hasBody("hero"), false);
    assert.deepEqual(physics.characterIds(), []);
    assert.equal(physics.stats().bodies, 1);
    assert.throws(() => physics.remove("hero"), /Unknown physics body "hero"/);
    assert.throws(() => physics.state("hero"), /Unknown physics body/);
    assert.throws(() => physics.layerOf("hero"), /Unknown physics body/);
    assert.throws(() => physics.moveCharacter("hero", ORIGIN), /Unknown physics body/);
    assert.throws(() => physics.setBodyTranslation("hero", ORIGIN), /Unknown physics body/);

    // Removed ids can be reused and queries no longer see the old collider.
    physics.addKinematicCharacter({ id: "hero", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    assert.equal(physics.raycast({ origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } })?.entityId, "hero");
    physics.remove("hero");
    assert.equal(physics.raycast({ origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } })?.entityId, "floor");
  });
});

test("advance accumulates fractional time, clamps spikes and rejects bad deltas", async () => {
  await withWorld((physics) => {
    assert.equal(physics.advance(0), 0);
    assert.equal(physics.advance(1 / 120), 0, "half a step runs nothing");
    assert.equal(physics.advance(1 / 120), 1, "the remainder completes the step");
    assert.equal(physics.advance(10), 15, "a long pause is clamped to 0.25 s = 15 steps");
    assert.equal(physics.stats().fixedSteps, 16);
    for (const dt of [NaN, Infinity, -1 / 60]) {
      assert.throws(() => physics.advance(dt), RangeError, `advance(${dt})`);
    }
    assert.equal(physics.stats().fixedSteps, 16, "rejected deltas never step the world");
  });
});

test("setBodyTranslation can zero velocity and keeps the body queryable at the new place", async () => {
  await withWorld((physics) => {
    physics.addDynamicBody({ id: "ball", position: { x: 0, y: 10, z: 0 }, shape: "sphere", radius: 0.5 });
    physics.advance(0.25);
    assert.ok(physics.state("ball").linearVelocity.y < -1, "ball is falling");

    physics.setBodyTranslation("ball", { x: 5, y: 2, z: 0 });
    assert.ok(physics.state("ball").linearVelocity.y < -1, "velocity is kept by default");

    physics.setBodyTranslation("ball", { x: 5, y: 2, z: 0 }, true);
    assert.deepEqual(physics.state("ball").linearVelocity, ORIGIN);
    const hit = physics.raycast({ origin: { x: 5, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } });
    assert.equal(hit?.entityId, "ball");
    assert.ok(Math.abs((hit?.point.y ?? 0) - 2.5) < 1e-3);
  });
});

test("moveCharacter reports free movement as not collided and slides along a wall", async () => {
  await withWorld(
    (physics) => {
      physics.addFixedBox({ id: "wall", position: { x: 2, y: 1, z: 0 }, halfExtents: { x: 0.25, y: 2, z: 5 } });
      physics.addKinematicCharacter({ id: "hero", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });

      const free = physics.moveCharacter("hero", { x: 0, y: 0, z: 1 });
      assert.equal(free.collided, false);
      assert.ok(Math.abs(free.actual.z - 1) < 1e-6);

      // Diagonal into the wall: x is blocked, z keeps sliding.
      const slide = physics.moveCharacter("hero", { x: 4, y: 0, z: 1 });
      assert.equal(slide.collided, true);
      assert.ok(slide.actual.x < 1.4);
      assert.ok(slide.actual.z > 0.9, `slide keeps z motion, got ${slide.actual.z}`);
      assert.deepEqual(slide.requested, { x: 4, y: 0, z: 1 });
    },
    { gravity: ORIGIN },
  );
});

test("moveCharacter on the very first call does not integrate other bodies twice", async () => {
  await withWorld((physics) => {
    physics.addDynamicBody({ id: "ball", position: { x: 0, y: 50, z: 0 }, shape: "sphere" });
    physics.addKinematicCharacter({ id: "hero", position: { x: 10, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    physics.moveCharacter("hero", { x: 0, y: 0, z: 0 });
    assert.equal(physics.stats().fixedSteps, 1, "the warm-up step is counted exactly once");
    physics.moveCharacter("hero", { x: 0, y: 0, z: 0 });
    assert.equal(physics.stats().fixedSteps, 1, "later moves never step again");
  });
});

test("state refuses to report a body whose simulation went non-finite", async () => {
  await withWorld((physics) => {
    physics.addDynamicBody({ id: "ball", position: ORIGIN, shape: "sphere" });
    // Bypass the validated API on purpose to simulate a corrupted Rapier body.
    const raw = physics.world.getRigidBody(0);
    raw.setTranslation({ x: NaN, y: 0, z: 0 }, true);
    assert.throws(() => physics.state("ball"), /non-finite/);
  });
});

test("dispose is safe to call repeatedly and after bodies were removed", async () => {
  const physics = await RapierPhysicsWorld.create();
  physics.addKinematicCharacter({ id: "hero", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
  physics.remove("hero");
  physics.dispose();
  physics.dispose();
});

test("scene factory: kinematic RigidBody types, capsule/box dynamics, fallbacks and autostep", async () => {
  const physics = await createPhysicsWorldFromScene(
    sceneOf([
      { id: "plain", name: "Plain", components: { Transform: { position: [1, 2, 3] } } },
      { id: "kin", name: "Kin", components: { Transform: { position: [0, 1, 0] }, RigidBody: { type: "KinematicPositionBased" }, Collider: { radius: 0.3, halfHeight: 0.6 } } },
      { id: "hero", name: "Hero", components: { Transform: { position: [4, 1, 0] }, CharacterBody: { offset: 0.02, autostepMaxHeight: 0.3, autostepMinWidth: 0.2 }, Primitive: { radius: 0.35 } } },
      { id: "capsule", name: "Capsule", components: { Transform: { position: [0, 5, 0] }, RigidBody: { type: "dynamic", gravityScale: 0 }, Collider: { shape: "capsule", radius: 0.3, halfHeight: 0.7, friction: 0.5, restitution: 0.1 } } },
      { id: "crate", name: "Crate", components: { Transform: { position: [0, 8, 0] }, RigidBody: { type: "dynamic" }, Collider: { halfExtents: [0.25, 0.5, 0.75] } } },
      { id: "crate2", name: "Crate2", components: { Transform: { position: [20, 9, 0] }, RigidBody: { type: "dynamic" }, Primitive: { kind: "box", size: [2, 4, 6] } } },
      { id: "badvec", name: "BadVec", components: { Transform: { position: [1, "x", 3] }, RigidBody: { type: "dynamic" }, Collider: { shape: "ball", radius: "big" } } },
      { id: "floor", name: "Floor", components: { Transform: { position: [0, -1, 0] }, Collider: { size: [20, 2, 20], layer: 7, friction: 0.9, restitution: 0 } } },
    ]),
  );
  try {
    assert.equal(physics.hasBody("plain"), false, "entities without physics components are skipped");
    assert.deepEqual(physics.characterIds().sort(), ["hero", "kin"]);
    assert.equal(physics.layerOf("floor"), 7);
    assert.equal(physics.layerOf("capsule"), 0, "no layer means default layer 0");

    // gravityScale 0 keeps the capsule where it was authored after the pre-seed step.
    assert.deepEqual(physics.state("capsule").position, { x: 0, y: 5, z: 0 });
    // Non-numeric radius and malformed position fall back to defaults (ball radius 0.5, origin).
    assert.deepEqual(physics.state("badvec").position, ORIGIN);
    // Dynamic bodies are restored to their authored position and are at rest after the pre-seed step.
    assert.deepEqual(physics.state("crate").position, { x: 0, y: 8, z: 0 });
    assert.deepEqual(physics.state("crate").linearVelocity, ORIGIN);
    assert.equal(physics.stats().fixedSteps, 1, "only the warm-up step ran");

    // halfExtents wins over size; size is halved; both are queryable.
    const crateHit = physics.raycast({ origin: { x: 0, y: 8, z: 10 }, direction: { x: 0, y: 0, z: -1 }, layers: [0] });
    assert.equal(crateHit?.entityId, "crate");
    assert.ok(Math.abs((crateHit?.distance ?? 0) - 9.25) < 1e-3, `crate z half extent 0.75, got ${crateHit?.distance}`);
    const crate2Hit = physics.raycast({ origin: { x: 20, y: 9, z: 10 }, direction: { x: 0, y: 0, z: -1 }, layers: [0] });
    assert.equal(crate2Hit?.entityId, "crate2");
    assert.ok(Math.abs((crate2Hit?.distance ?? 0) - 7) < 1e-3, `crate2 z half extent 3, got ${crate2Hit?.distance}`);
  } finally {
    physics.dispose();
  }
});

test("scene factory disposes the Rapier world and rethrows when an entity is invalid", async () => {
  const bad = sceneOf([
    { id: "ok", name: "Ok", components: { RigidBody: { type: "fixed" }, Collider: { size: [1, 1, 1] } } },
    { id: "flat", name: "Flat", components: { RigidBody: { type: "fixed" }, Collider: { size: [1, 0, 1] } } },
  ]);
  await assert.rejects(() => createPhysicsWorldFromScene(bad), RangeError);

  const dup = sceneOf([
    { id: "a", name: "A", components: { RigidBody: { type: "fixed" } } },
    { id: "a", name: "A2", components: { RigidBody: { type: "fixed" } } },
  ]);
  await assert.rejects(() => createPhysicsWorldFromScene(dup), /already exists/);

  // A later, valid scene still builds fine on the same module-level Rapier instance.
  const good = await createPhysicsWorldFromScene(sceneOf([{ id: "a", name: "A", components: { RigidBody: { type: "fixed" } } }]));
  try {
    assert.deepEqual(good.bodyIds(), ["a"]);
  } finally {
    good.dispose();
  }
});

test("scene factory builds an empty world for an empty scene without stepping", async () => {
  const physics = await createPhysicsWorldFromScene(sceneOf([]));
  try {
    assert.equal(physics.stats().bodies, 0);
    assert.equal(physics.stats().fixedSteps, 0);
  } finally {
    physics.dispose();
  }
});
