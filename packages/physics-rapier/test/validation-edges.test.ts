import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import {
  collectPhysicsSceneDiagnostics,
  createPhysicsWorldFromScene,
  RapierPhysicsWorld,
} from "../src/index.js";

const at = { Transform: { position: [0, 0, 0] } };

function scene(entities: SceneDefinition["entities"]): SceneDefinition {
  return { id: stableId("scene", "validation-edges"), name: "Validation edges", entities };
}

/** Counts of live bodies/colliders: a rejected add must leave both untouched (no orphan). */
function counts(world: RapierPhysicsWorld): [number, number] {
  const stats = world.stats();
  return [stats.bodies, stats.colliders];
}

test("addFixedSphere / addFixedCapsule / addKinematicBody reject negative friction and restitution without leaving an orphan body", async () => {
  const world = await RapierPhysicsWorld.create();
  try {
    const before = counts(world);
    const position = { x: 0, y: 0, z: 0 };
    const attempts: Array<[string, () => void, RegExp]> = [
      ["sphere friction", () => world.addFixedSphere({ id: "s1", position, radius: 1, friction: -1 }), /friction/],
      ["sphere restitution", () => world.addFixedSphere({ id: "s2", position, radius: 1, restitution: -0.1 }), /restitution/],
      ["capsule friction", () => world.addFixedCapsule({ id: "c1", position, halfHeight: 1, radius: 1, friction: -1 }), /friction/],
      ["capsule restitution", () => world.addFixedCapsule({ id: "c2", position, halfHeight: 1, radius: 1, restitution: -1 }), /restitution/],
      ["kinematic friction", () => world.addKinematicBody({ id: "k1", position, shape: "box", friction: -1 }), /friction/],
      ["kinematic restitution", () => world.addKinematicBody({ id: "k2", position, shape: "sphere", restitution: -1 }), /restitution/],
      ["sphere NaN friction", () => world.addFixedSphere({ id: "s3", position, radius: 1, friction: Number.NaN }), /friction/],
    ];
    for (const [label, attempt, pattern] of attempts) {
      assert.throws(attempt, (error: unknown) => error instanceof RangeError && pattern.test(error.message), label);
    }
    assert.deepEqual(counts(world), before);
    for (const id of ["s1", "s2", "s3", "c1", "c2", "k1", "k2"]) assert.equal(world.hasBody(id), false, id);
  } finally {
    world.dispose();
  }
});

test("addKinematicBody defaults its box to 0.5 half extents and rejects an unknown shape before creating anything", async () => {
  const world = await RapierPhysicsWorld.create({ gravity: { x: 0, y: 0, z: 0 } });
  try {
    world.addKinematicBody({ id: "door", position: { x: 0, y: 0, z: 0 }, shape: "box", friction: 0.3, restitution: 0.1 });
    const hit = world.raycast({ origin: { x: 5, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 } });
    assert.equal(hit?.entityId, "door");
    assert.ok(Math.abs((hit?.point.x ?? Number.NaN) - 0.5) < 1e-6, "default half extent is 0.5");

    const before = counts(world);
    assert.throws(
      () =>
        world.addKinematicBody({
          id: "bad",
          position: { x: 0, y: 0, z: 0 },
          shape: "capsule" as unknown as "box",
        }),
      /Unsupported kinematic body shape "capsule"/,
    );
    assert.deepEqual(counts(world), before);
    assert.equal(world.hasBody("bad"), false);
  } finally {
    world.dispose();
  }
});

test("a rejected add never consumes the id: the same id can be added again with valid input", async () => {
  const world = await RapierPhysicsWorld.create();
  try {
    assert.throws(() => world.addFixedSphere({ id: "orb", position: { x: 0, y: 0, z: 0 }, radius: 0 }), RangeError);
    world.addFixedSphere({ id: "orb", position: { x: 0, y: 0, z: 0 }, radius: 1 });
    assert.equal(world.hasBody("orb"), true);
    assert.throws(() => world.addFixedSphere({ id: "orb", position: { x: 0, y: 0, z: 0 }, radius: 1 }), /already exists/);
  } finally {
    world.dispose();
  }
});

test("a dynamic box uses Collider.halfExtents (not size) when both are authored", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "crate",
        name: "Crate",
        components: {
          Transform: { position: [0, 0, 0] },
          RigidBody: { type: "dynamic", gravityScale: 0 },
          Collider: { shape: "box", halfExtents: [1, 2, 3], size: [10, 10, 10] },
        },
      },
    ]),
    { gravity: { x: 0, y: 0, z: 0 } },
  );
  try {
    const along = (axis: "x" | "y" | "z"): number => {
      const origin = { x: 0, y: 0, z: 0, [axis]: 20 };
      const direction = { x: 0, y: 0, z: 0, [axis]: -1 };
      return physics.raycast({ origin, direction })?.point[axis] ?? Number.NaN;
    };
    assert.ok(Math.abs(along("x") - 1) < 1e-6);
    assert.ok(Math.abs(along("y") - 2) < 1e-6);
    assert.ok(Math.abs(along("z") - 3) < 1e-6);
  } finally {
    physics.dispose();
  }
});

test("a fixed box uses Collider.halfExtents (not size), and a malformed halfExtents array falls back to 0.5", async () => {
  const physics = await createPhysicsWorldFromScene(
    scene([
      {
        id: "wall",
        name: "Wall",
        components: {
          Transform: { position: [0, 0, 0] },
          Collider: { shape: "box", halfExtents: [1, 2, 3], size: [10, 10, 10] },
        },
      },
      {
        id: "bad-wall",
        name: "Bad wall",
        components: {
          Transform: { position: [100, 0, 0] },
          Collider: { shape: "box", halfExtents: [1, "x", 3], size: [10, 10, 10] },
        },
      },
    ]),
    { gravity: { x: 0, y: 0, z: 0 } },
  );
  try {
    const hitX = physics.raycast({ origin: { x: 20, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, layers: [0] });
    const hitZ = physics.raycast({ origin: { x: 0, y: 0, z: 20 }, direction: { x: 0, y: 0, z: -1 }, layers: [0] });
    assert.ok(Math.abs((hitX?.point.x ?? Number.NaN) - 1) < 1e-6);
    assert.ok(Math.abs((hitZ?.point.z ?? Number.NaN) - 3) < 1e-6);
    // The array is present but invalid: vec3Value falls back to 0.5, it does not read `size`.
    const bad = physics.raycast({ origin: { x: 120, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, excludeEntityIds: ["wall"] });
    assert.equal(bad?.entityId, "bad-wall");
    assert.ok(Math.abs((bad?.point.x ?? Number.NaN) - 100.5) < 1e-6);
  } finally {
    physics.dispose();
  }
});

test("collectPhysicsSceneDiagnostics: entities without physics components, empty-string shapes and boxy kinematic platforms stay silent", () => {
  const diagnostics = collectPhysicsSceneDiagnostics(
    scene([
      // No RigidBody / Collider / CharacterBody: not a physics entity at all.
      { id: "decor", name: "Decor", components: { ...at, Primitive: { kind: "torus" } } },
      // An empty Collider.shape counts as undeclared, so it hides the Primitive kind like the factory does.
      { id: "blank", name: "Blank", components: { ...at, Collider: { shape: "" }, Primitive: { kind: "torus" } } },
      // A kinematic platform keeps its box / sphere / ball shape, so nothing is substituted.
      { id: "lift", name: "Lift", components: { ...at, RigidBody: { type: "kinematic" }, Collider: { shape: "box" } } },
      { id: "pearl", name: "Pearl", components: { ...at, RigidBody: { type: "kinematicVelocityBased" }, Collider: { shape: "ball" } } },
    ]),
  );
  assert.deepEqual(diagnostics, []);
});

test("collectPhysicsSceneDiagnostics: a null Collider.shape falls through to the Primitive kind", () => {
  const [diagnostic, ...rest] = collectPhysicsSceneDiagnostics(
    scene([{ id: "knot", name: "Knot", components: { ...at, Collider: { shape: null }, Primitive: { kind: "torus" } } }]),
  );
  assert.equal(rest.length, 0);
  assert.equal(diagnostic?.source, "Primitive.kind");
  assert.equal(diagnostic?.shape, "torus");
  assert.equal(diagnostic?.bodyType, "fixed");
});

test("collectPhysicsSceneDiagnostics: a CharacterBody with a non-capsule Collider.shape reports the character fallback and its capsule remediation", () => {
  const [diagnostic, ...rest] = collectPhysicsSceneDiagnostics(
    scene([
      {
        id: "hero",
        name: "Hero",
        components: { ...at, CharacterBody: {}, Collider: { shape: "box" } },
      },
    ]),
  );
  assert.equal(rest.length, 0);
  assert.equal(diagnostic?.bodyType, "character");
  assert.equal(diagnostic?.fallback, "capsule");
  assert.equal(diagnostic?.source, "Collider.shape");
  assert.match(diagnostic?.remediation ?? "", /capsule/);
  assert.doesNotMatch(diagnostic?.remediation ?? "", /sphere/);
});

test("collectPhysicsSceneDiagnostics is pure: it does not mutate the scene and repeats exactly", () => {
  const input = scene([
    { id: "a", name: "A", components: { ...at, Collider: { shape: "cone" } } },
    { id: "b", name: "B", components: { ...at, RigidBody: { type: "dynamic" }, Collider: { shape: 7 } } },
  ]);
  const snapshot = JSON.stringify(input);
  const first = collectPhysicsSceneDiagnostics(input);
  const second = collectPhysicsSceneDiagnostics(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(first, second);
  assert.equal(first[1]?.shape, "7");
});
