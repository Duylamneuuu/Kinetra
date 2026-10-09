import assert from "node:assert/strict";
import test from "node:test";

import { stableId, type SceneDefinition } from "@kinetra/project-model";

import {
  createPhysicsWorldFromScene,
  RapierPhysicsWorld,
  type PhysicsHit,
} from "../src/index.js";

function approx(
  actual: number,
  expected: number,
  label: string,
  tolerance = 1e-4,
): void {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

async function arenaWorld(): Promise<RapierPhysicsWorld> {
  const physics = await RapierPhysicsWorld.create();
  // Floor top at y = 0.
  physics.addFixedBox({
    id: "floor",
    position: { x: 0, y: -0.5, z: 0 },
    halfExtents: { x: 20, y: 0.5, z: 20 },
    layer: 1,
  });
  // Wall face at x = 5 (facing -x).
  physics.addFixedBox({
    id: "wall",
    position: { x: 6, y: 2, z: 0 },
    halfExtents: { x: 1, y: 2, z: 5 },
    layer: 2,
  });
  // Unit-radius sphere target at (0, 1, -8), layer 3.
  physics.addFixedBox({
    id: "crate",
    position: { x: 0, y: 1, z: -8 },
    halfExtents: { x: 1, y: 1, z: 1 },
    layer: 3,
  });
  return physics;
}

test("raycast hits the closest entity with point, normal and distance", async () => {
  const physics = await arenaWorld();
  try {
    const down = physics.raycast({
      origin: { x: 2, y: 5, z: 2 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.ok(down);
    assert.equal(down.entityId, "floor");
    approx(down.distance, 5, "distance");
    approx(down.point.x, 2, "point.x");
    approx(down.point.y, 0, "point.y");
    approx(down.point.z, 2, "point.z");
    assert.deepEqual(
      [down.normal.x, down.normal.y, down.normal.z].map((v) =>
        Math.round(v * 1e4) / 1e4,
      ),
      [0, 1, 0],
    );
    assert.equal(down.startedInside, false);

    const sideways = physics.raycast({
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 3, y: 0, z: 0 }, // non-unit direction is normalized
    });
    assert.ok(sideways);
    assert.equal(sideways.entityId, "wall");
    approx(sideways.distance, 5, "wall distance");
    approx(sideways.normal.x, -1, "wall normal.x");
  } finally {
    physics.dispose();
  }
});

test("raycast result is a plain Kinetra struct without Rapier objects", async () => {
  const physics = await arenaWorld();
  try {
    const hit = physics.raycast({
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.ok(hit);
    assert.deepEqual(Object.keys(hit).sort(), [
      "distance",
      "entityId",
      "normal",
      "point",
      "startedInside",
    ]);
    // Must survive a JSON round trip unchanged (what the bridge / scripts rely on).
    assert.deepEqual(JSON.parse(JSON.stringify(hit)), hit);
  } finally {
    physics.dispose();
  }
});

test("raycast respects maxDistance and returns null on a miss", async () => {
  const physics = await arenaWorld();
  try {
    assert.equal(
      physics.raycast({
        origin: { x: 0, y: 5, z: 0 },
        direction: { x: 0, y: -1, z: 0 },
        maxDistance: 4.9,
      }),
      null,
    );
    assert.equal(
      physics.raycast({
        origin: { x: 0, y: 5, z: 0 },
        direction: { x: 0, y: 1, z: 0 },
      }),
      null,
    );
    const hit = physics.raycast({
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
      maxDistance: 5.1,
    });
    assert.equal(hit?.entityId, "floor");
  } finally {
    physics.dispose();
  }
});

test("raycast filters by layer and excluded entity ids", async () => {
  const physics = await arenaWorld();
  try {
    const ray = {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
    };
    assert.equal(physics.raycast(ray)?.entityId, "crate");
    // Layer filter that excludes the crate's layer sees nothing along this ray.
    assert.equal(physics.raycast({ ...ray, layers: [1, 2] }), null);
    assert.equal(physics.raycast({ ...ray, layers: [3] })?.entityId, "crate");
    assert.equal(physics.raycast({ ...ray, layers: [] }), null);
    assert.equal(
      physics.raycast({ ...ray, excludeEntityIds: ["crate"] }),
      null,
    );

    // A ray through the wall and then the floor: excluding the first falls through to next.
    const slanted = {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: -0.05, z: 0 },
    };
    assert.equal(physics.raycast(slanted)?.entityId, "wall");
    assert.equal(
      physics.raycast({ ...slanted, excludeEntityIds: ["wall"] })?.entityId,
      "floor",
    );
    assert.equal(
      physics.raycast({ ...slanted, layers: [1] })?.entityId,
      "floor",
    );
  } finally {
    physics.dispose();
  }
});

test("raycast from inside a solid reports startedInside with distance 0", async () => {
  const physics = await arenaWorld();
  try {
    const hit = physics.raycast({
      origin: { x: 0, y: 1, z: -8 },
      direction: { x: 0, y: 0, z: -1 },
    });
    assert.ok(hit);
    assert.equal(hit.entityId, "crate");
    assert.equal(hit.startedInside, true);
    assert.equal(hit.distance, 0);
    assert.deepEqual(hit.point, { x: 0, y: 1, z: -8 });
    assert.deepEqual(hit.normal, { x: 0, y: 0, z: 1 });
  } finally {
    physics.dispose();
  }
});

test("raycast is deterministic and does not mutate the simulation", async () => {
  const physics = await arenaWorld();
  try {
    physics.addDynamicBody({
      id: "ball",
      position: { x: 0, y: 3, z: 0 },
      shape: "sphere",
      radius: 0.5,
    });
    physics.advance(1 / 60);
    const before = physics.stats();
    const stateBefore = physics.state("ball");
    const results: Array<PhysicsHit | null> = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        physics.raycast({
          origin: { x: 4, y: 5, z: 1 },
          direction: { x: -0.2, y: -1, z: 0.1 },
        }),
      );
    }
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual(physics.stats(), before);
    assert.deepEqual(physics.state("ball"), stateBefore);
  } finally {
    physics.dispose();
  }
});

test("raycast follows moving dynamic bodies and forgets removed ones", async () => {
  const physics = await arenaWorld();
  try {
    physics.addDynamicBody({
      id: "ball",
      position: { x: 0, y: 3, z: 0 },
      shape: "sphere",
      radius: 0.5,
      gravityScale: 0,
      layer: 4,
    });
    physics.advance(1 / 60);
    const down = {
      origin: { x: 0, y: 10, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    };
    assert.equal(physics.raycast(down)?.entityId, "ball");
    physics.setBodyTranslation("ball", { x: 3, y: 3, z: 0 }, true);
    physics.advance(1 / 60);
    assert.equal(physics.raycast(down)?.entityId, "floor");
    physics.remove("ball");
    physics.advance(1 / 60);
    assert.equal(
      physics.raycast({
        origin: { x: 3, y: 10, z: 0 },
        direction: { x: 0, y: -1, z: 0 },
      })?.entityId,
      "floor",
    );
    assert.throws(() => physics.layerOf("ball"), /Unknown physics body/);
  } finally {
    physics.dispose();
  }
});

test("raycast rejects malformed input with RangeError", async () => {
  const physics = await arenaWorld();
  try {
    const good = {
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    };
    const bad: Array<Record<string, unknown>> = [
      { ...good, direction: { x: 0, y: 0, z: 0 } },
      { ...good, direction: { x: Number.NaN, y: 1, z: 0 } },
      { ...good, direction: { x: Infinity, y: 0, z: 0 } },
      { ...good, origin: { x: 0, y: Number.NaN, z: 0 } },
      { ...good, maxDistance: 0 },
      { ...good, maxDistance: -1 },
      { ...good, maxDistance: Number.POSITIVE_INFINITY },
      { ...good, maxDistance: Number.NaN },
      { ...good, layers: [1.5] },
      { ...good, layers: [-1] },
      { ...good, layers: [32] },
      { ...good, layers: [Number.NaN] },
    ];
    for (const query of bad) {
      assert.throws(
        () => physics.raycast(query as never),
        RangeError,
        JSON.stringify(query),
      );
    }
    assert.throws(
      () => physics.raycast({ ...good, layers: "1" as never }),
      TypeError,
    );
    assert.throws(
      () => physics.raycast({ ...good, origin: undefined as never }),
      RangeError,
    );
  } finally {
    physics.dispose();
  }
});

test("shapeCast sphere lands on the floor with contact point and normal", async () => {
  const physics = await arenaWorld();
  try {
    const hit = physics.shapeCast({
      shape: { type: "sphere", radius: 0.5 },
      origin: { x: 2, y: 5, z: 2 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.ok(hit);
    assert.equal(hit.entityId, "floor");
    approx(hit.distance, 4.5, "distance");
    approx(hit.point.x, 2, "point.x", 5e-3);
    approx(hit.point.y, 0, "point.y", 5e-3);
    approx(hit.point.z, 2, "point.z", 5e-3);
    approx(hit.normal.y, 1, "normal.y", 1e-3);
    assert.equal(hit.startedInside, false);
  } finally {
    physics.dispose();
  }
});

test("shapeCast box and capsule account for their extents", async () => {
  const physics = await arenaWorld();
  try {
    const box = physics.shapeCast({
      shape: { type: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    assert.ok(box);
    assert.equal(box.entityId, "wall");
    approx(box.distance, 4.5, "box distance");
    approx(box.point.x, 5, "box point.x", 5e-3);
    approx(box.normal.x, -1, "box normal.x", 1e-3);

    const capsule = physics.shapeCast({
      shape: { type: "capsule", halfHeight: 0.5, radius: 0.25 },
      origin: { x: 0, y: 3, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.ok(capsule);
    assert.equal(capsule.entityId, "floor");
    // capsule bottom = center - halfHeight - radius = 0.75 below the origin.
    approx(capsule.distance, 2.25, "capsule distance");
  } finally {
    physics.dispose();
  }
});

test("shapeCast honours rotation", async () => {
  const physics = await arenaWorld();
  try {
    const half = Math.SQRT1_2;
    // Capsule lying along x (rotated 90° around z) falls onto the floor: only its radius matters.
    const lying = physics.shapeCast({
      shape: { type: "capsule", halfHeight: 1, radius: 0.25 },
      rotation: { x: 0, y: 0, z: half, w: half },
      origin: { x: 0, y: 3, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.ok(lying);
    approx(lying.distance, 2.75, "lying capsule distance");
  } finally {
    physics.dispose();
  }
});

test("shapeCast filters by layer, excludes ids and reports penetration", async () => {
  const physics = await arenaWorld();
  try {
    const query = {
      shape: { type: "sphere", radius: 0.25 } as const,
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
    };
    assert.equal(physics.shapeCast(query)?.entityId, "crate");
    assert.equal(physics.shapeCast({ ...query, layers: [1] }), null);
    assert.equal(physics.shapeCast({ ...query, layers: [] }), null);
    assert.equal(
      physics.shapeCast({ ...query, excludeEntityIds: ["crate"] }),
      null,
    );
    assert.equal(physics.shapeCast({ ...query, maxDistance: 5 }), null);

    const penetrating = physics.shapeCast({
      ...query,
      origin: { x: 0, y: 1, z: -7.8 },
    });
    assert.ok(penetrating);
    assert.equal(penetrating.startedInside, true);
    assert.equal(penetrating.distance, 0);
    assert.deepEqual(penetrating.normal, { x: 0, y: 0, z: 1 });
  } finally {
    physics.dispose();
  }
});

test("shapeCast rejects malformed shapes, rotations and directions", async () => {
  const physics = await arenaWorld();
  try {
    const base = {
      shape: { type: "sphere", radius: 0.5 },
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    };
    const bad: Array<Record<string, unknown>> = [
      { ...base, shape: { type: "sphere", radius: 0 } },
      { ...base, shape: { type: "sphere", radius: Number.NaN } },
      { ...base, shape: { type: "box", halfExtents: { x: 1, y: 0, z: 1 } } },
      { ...base, shape: { type: "capsule", halfHeight: -1, radius: 1 } },
      { ...base, shape: { type: "plane" } },
      { ...base, shape: undefined },
      { ...base, direction: { x: 0, y: 0, z: 0 } },
      { ...base, rotation: { x: 0, y: 0, z: 0, w: 0 } },
      { ...base, rotation: { x: 0, y: 0, z: 0, w: Number.NaN } },
      { ...base, rotation: { x: 1, y: 1, z: 1, w: 1 } },
      { ...base, maxDistance: 0 },
      { ...base, layers: [99] },
    ];
    for (const query of bad) {
      assert.throws(
        () => physics.shapeCast(query as never),
        RangeError,
        JSON.stringify(query),
      );
    }
  } finally {
    physics.dispose();
  }
});

test("layers are validated when bodies are created and readable back", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    assert.throws(
      () =>
        physics.addFixedBox({
          id: "a",
          position: { x: 0, y: 0, z: 0 },
          halfExtents: { x: 1, y: 1, z: 1 },
          layer: 32,
        }),
      RangeError,
    );
    assert.throws(
      () =>
        physics.addDynamicBody({
          id: "b",
          position: { x: 0, y: 0, z: 0 },
          shape: "sphere",
          layer: 1.5,
        }),
      RangeError,
    );
    // A rejected add must not leave a half-registered body behind.
    assert.equal(physics.hasBody("a"), false);
    assert.equal(physics.hasBody("b"), false);
    physics.addFixedBox({
      id: "a",
      position: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 1, y: 1, z: 1 },
    });
    assert.equal(physics.layerOf("a"), 0);
  } finally {
    physics.dispose();
  }
});

test("character bodies are hit by raycasts and carry their layer", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    physics.addKinematicCharacter({
      id: "hero",
      position: { x: 0, y: 1, z: 0 },
      halfHeight: 0.5,
      radius: 0.4,
      layer: 7,
    });
    physics.advance(1 / 60);
    const ray = {
      origin: { x: 5, y: 1, z: 0 },
      direction: { x: -1, y: 0, z: 0 },
    };
    const hit = physics.raycast(ray);
    assert.equal(hit?.entityId, "hero");
    approx(hit?.distance ?? NaN, 4.6, "hero distance");
    assert.equal(physics.layerOf("hero"), 7);
    assert.equal(physics.raycast({ ...ray, layers: [0] }), null);
  } finally {
    physics.dispose();
  }
});

test("scene factory assigns Collider.layer and queries use it", async () => {
  const scene: SceneDefinition = {
    id: stableId("scene", "query"),
    name: "query",
    entities: [
      {
        id: stableId("entity", "floor"),
        name: "floor",
        components: {
          Transform: { position: [0, -0.5, 0] },
          Collider: { size: [20, 1, 20], layer: 2 },
        },
      },
      {
        id: stableId("entity", "pillar"),
        name: "pillar",
        components: {
          Transform: { position: [3, 1, 0] },
          RigidBody: { type: "fixed" },
          Collider: { size: [1, 2, 1] },
        },
      },
    ],
  } as unknown as SceneDefinition;
  const physics = await createPhysicsWorldFromScene(scene);
  try {
    const floorId = stableId("entity", "floor");
    const pillarId = stableId("entity", "pillar");
    assert.equal(physics.layerOf(floorId), 2);
    assert.equal(physics.layerOf(pillarId), 0);
    const ray = {
      origin: { x: 3, y: 5, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    };
    assert.equal(physics.raycast(ray)?.entityId, pillarId);
    assert.equal(physics.raycast({ ...ray, layers: [2] })?.entityId, floorId);
  } finally {
    physics.dispose();
  }
});

test("interleaved queries never change the simulation trajectory", async () => {
  async function run(withQueries: boolean): Promise<string> {
    const physics = await RapierPhysicsWorld.create();
    try {
      physics.addFixedBox({
        id: "floor",
        position: { x: 0, y: -0.5, z: 0 },
        halfExtents: { x: 20, y: 0.5, z: 20 },
      });
      physics.addDynamicBody({
        id: "ball",
        position: { x: 0.2, y: 6, z: 0 },
        shape: "sphere",
        radius: 0.5,
      });
      const states: unknown[] = [];
      for (let i = 0; i < 120; i++) {
        if (withQueries) {
          physics.raycast({
            origin: { x: 0, y: 20, z: 0 },
            direction: { x: 0, y: -1, z: 0 },
          });
          physics.shapeCast({
            shape: { type: "sphere", radius: 0.1 },
            origin: { x: 1, y: 9, z: 0 },
            direction: { x: -1, y: -1, z: 0 },
          });
        }
        if (i === 60) {
          physics.setBodyTranslation("ball", { x: 0.2, y: 6, z: 0 }, true);
        }
        physics.advance(1 / 60);
        states.push(physics.state("ball"), physics.stats());
      }
      return JSON.stringify(states);
    } finally {
      physics.dispose();
    }
  }
  assert.equal(await run(true), await run(false));
});

test("a query right after adding a body sees it without any step", async () => {
  const physics = await RapierPhysicsWorld.create();
  try {
    physics.addFixedBox({
      id: "late",
      position: { x: 0, y: 0, z: 0 },
      halfExtents: { x: 1, y: 1, z: 1 },
    });
    assert.equal(physics.stats().fixedSteps, 0);
    const hit = physics.raycast({
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
    });
    assert.equal(hit?.entityId, "late");
    assert.equal(physics.stats().fixedSteps, 0);
    approx(hit?.distance ?? NaN, 4, "distance");
  } finally {
    physics.dispose();
  }
});
