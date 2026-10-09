import assert from "node:assert/strict";
import test from "node:test";

import { RapierPhysicsWorld } from "../src/index.js";

const ORIGIN = { x: 0, y: 0, z: 0 };

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

/** Small deterministic PRNG so the fuzz cases are reproducible without extra dependencies. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function populate(physics: RapierPhysicsWorld, seed: number): void {
  const random = mulberry32(seed);
  physics.addFixedBox({
    id: "floor",
    position: { x: 0, y: -0.5, z: 0 },
    halfExtents: { x: 50, y: 0.5, z: 50 },
    restitution: 0.2,
  });
  const shapes = ["box", "sphere", "capsule"] as const;
  for (let index = 0; index < 8; index++) {
    physics.addDynamicBody({
      id: `body-${index}`,
      position: {
        x: (random() - 0.5) * 6,
        y: 1 + random() * 6,
        z: (random() - 0.5) * 6,
      },
      shape: shapes[index % shapes.length]!,
      radius: 0.2 + random() * 0.3,
      halfHeight: 0.2 + random() * 0.3,
      halfExtents: { x: 0.2 + random() * 0.3, y: 0.2 + random() * 0.3, z: 0.2 + random() * 0.3 },
    });
  }
}

function snapshot(physics: RapierPhysicsWorld): string {
  return JSON.stringify(physics.bodyIds().map((id) => physics.state(id)));
}

test("identical setup and identical step count give bit-identical world state (fuzzed seeds)", async () => {
  for (const seed of [1, 7, 42, 1337, 2024]) {
    let first = "";
    let second = "";
    await withWorld((physics) => {
      populate(physics, seed);
      for (let step = 0; step < 90; step++) physics.step();
      first = snapshot(physics);
    });
    await withWorld((physics) => {
      populate(physics, seed);
      for (let step = 0; step < 90; step++) physics.step();
      second = snapshot(physics);
    });
    assert.equal(second, first, `seed ${seed} must replay identically`);
  }
});

test("advance() performs the same total steps and yields the same state however the delta is sliced", async () => {
  const fixed = 1 / 60;
  const total = 2;
  let reference = "";
  let referenceSteps = 0;
  await withWorld((physics) => {
    populate(physics, 99);
    for (let index = 0; index < Math.round(total / fixed); index++) physics.advance(fixed);
    reference = snapshot(physics);
    referenceSteps = physics.stats().fixedSteps;
  });
  assert.equal(referenceSteps, 120);

  const slicings: number[][] = [
    [fixed / 2, fixed / 2],
    [fixed / 3, fixed / 3, fixed / 3],
    [fixed * 2],
  ];
  for (const slice of slicings) {
    await withWorld((physics) => {
      populate(physics, 99);
      let steps = 0;
      // Feed the same wall-clock total in differently shaped slices.
      for (let index = 0; index < Math.round(total / fixed); index += slice.length === 1 ? 2 : 1) {
        for (const part of slice) steps += physics.advance(part);
      }
      assert.equal(steps, referenceSteps, `slicing ${slice.length} parts`);
      assert.equal(snapshot(physics), reference, `slicing ${slice.length} parts`);
    });
  }
});

test("advance() clamps giant pauses to 0.25s and never banks the excess", async () => {
  await withWorld((physics) => {
    const steps = physics.advance(60);
    assert.equal(steps, 15, "0.25s / (1/60) = 15 fixed steps, no more");
    assert.ok(physics.stats().accumulatorSeconds < physics.fixedDeltaSeconds);
    assert.equal(physics.advance(0), 0, "zero delta does nothing");
  });
});

test("a one-off step(dt) does not change the cadence of later advance() calls", async () => {
  await withWorld((physics) => {
    physics.addDynamicBody({ id: "ball", position: { x: 0, y: 10, z: 0 }, shape: "sphere" });
    physics.step(1 / 30);
    assert.ok(Math.abs(physics.world.timestep - physics.fixedDeltaSeconds) < 1e-7, "timestep restored");
    assert.equal(physics.advance(physics.fixedDeltaSeconds), 1);
    assert.equal(physics.stats().fixedSteps, 2);
  });
});

test("invalid step(dt) values throw and leave the configured timestep intact", async () => {
  await withWorld((physics) => {
    for (const bad of [0, -1, NaN, Infinity]) {
      assert.throws(() => physics.step(bad), RangeError, String(bad));
    }
    assert.equal(physics.stats().fixedSteps, 0);
    assert.ok(Math.abs(physics.world.timestep - physics.fixedDeltaSeconds) < 1e-7, "timestep restored");
  });
});

test("dynamic bodies validate restitution and friction and default boxes to 0.5 half extents", async () => {
  await withWorld((physics) => {
    for (const [label, input] of [
      ["negative restitution", { restitution: -0.1 }],
      ["NaN restitution", { restitution: NaN }],
      ["negative friction", { friction: -1 }],
      ["Infinity friction", { friction: Infinity }],
    ] as const) {
      assert.throws(
        () => physics.addDynamicBody({ id: "d", position: ORIGIN, shape: "box", ...input }),
        RangeError,
        label,
      );
    }
    assert.equal(physics.stats().bodies, 0, "rejected bodies leave nothing behind");

    physics.addFixedBox({ id: "floor", position: { x: 0, y: -0.5, z: 0 }, halfExtents: { x: 10, y: 0.5, z: 10 } });
    physics.addDynamicBody({ id: "crate", position: { x: 0, y: 0.6, z: 0 }, shape: "box", restitution: 0, friction: 0.5 });
    for (let step = 0; step < 120; step++) physics.step();
    // Default box half extent is 0.5, so its centre rests ~0.5 above the floor top (y = 0).
    const resting = physics.state("crate").position.y;
    assert.ok(Math.abs(resting - 0.5) < 0.05, `crate rests at y=${resting}`);
  });
});

test("moveCharacter lazily drives a non-character body and remove() releases its controller", async () => {
  await withWorld((physics) => {
    physics.addFixedBox({ id: "floor", position: { x: 0, y: -0.5, z: 0 }, halfExtents: { x: 10, y: 0.5, z: 10 } });
    physics.addDynamicBody({ id: "drone", position: { x: 0, y: 1, z: 0 }, shape: "capsule", gravityScale: 0 });
    assert.deepEqual(physics.characterIds(), [], "a dynamic body is not listed as a character");

    const result = physics.moveCharacter("drone", { x: 1, y: 0, z: 0 });
    assert.equal(result.collided, false);
    assert.ok(Math.abs(physics.state("drone").position.x - 1) < 1e-6);

    physics.remove("drone");
    assert.equal(physics.hasBody("drone"), false);
    assert.throws(() => physics.state("drone"), /Unknown physics body "drone"/);
    assert.throws(() => physics.moveCharacter("drone", { x: 1, y: 0, z: 0 }), /Unknown physics body/);
    // The id is reusable and gets a fresh controller.
    physics.addDynamicBody({ id: "drone", position: { x: 0, y: 1, z: 0 }, shape: "sphere", gravityScale: 0 });
    assert.equal(physics.moveCharacter("drone", { x: 0, y: 0, z: 1 }).collided, false);
    assert.equal(physics.stats().bodies, 2);
  });
});

test("removing a kinematic character frees its body, collider and controller", async () => {
  await withWorld((physics) => {
    physics.addKinematicCharacter({ id: "hero", position: { x: 0, y: 1, z: 0 }, halfHeight: 0.5, radius: 0.4 });
    assert.deepEqual(physics.characterIds(), ["hero"]);
    physics.remove("hero");
    assert.deepEqual(physics.characterIds(), []);
    assert.equal(physics.stats().bodies, 0);
    assert.equal(physics.stats().colliders, 0);
    assert.throws(() => physics.remove("hero"), /Unknown physics body "hero"/);
  });
});
