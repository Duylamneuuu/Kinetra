import assert from "node:assert/strict";
import test from "node:test";

import { stableId, validateBuiltInComponent, type SceneDefinition } from "@kinetra/project-model";

import { createPhysicsWorldFromScene, resolveColliderPlan } from "../src/index.js";

// #529 item 2: the RigidBody defaults ("fixed" when `type` is absent, `mass` only meaningful for a
// dynamic body, `type` case-insensitive) are written down twice: in the project-model schema and in
// resolveColliderPlan. These tests run the same payloads through both, so a drift on either side
// turns one of them red instead of letting the editor accept what the world then reinterprets.

type Entity = SceneDefinition["entities"][number];

function entityWith(rigidBody: Record<string, unknown> | undefined): Entity {
  return {
    id: "body",
    name: "Body",
    components: {
      Transform: { position: [0, 1, 0] },
      ...(rigidBody ? { RigidBody: rigidBody } : {}),
      Collider: { shape: "box", halfExtents: [0.5, 0.5, 0.5] },
    },
  } as Entity;
}

const accepted: ReadonlyArray<readonly [string, Record<string, unknown>, "fixed" | "dynamic" | "kinematic"]> = [
  ["no type", {}, "fixed"],
  ["no type with mass 0", { mass: 0 }, "fixed"],
  ["fixed", { type: "fixed" }, "fixed"],
  ["fixed with mass 0", { type: "fixed", mass: 0 }, "fixed"],
  ["static alias", { type: "static" }, "fixed"],
  ["Static alias, mixed case", { type: "Static" }, "fixed"],
  ["dynamic", { type: "dynamic" }, "dynamic"],
  ["DYNAMIC, upper case", { type: "DYNAMIC", mass: 2 }, "dynamic"],
  ["kinematic with mass 0", { type: "kinematic", mass: 0 }, "kinematic"],
  ["kinematicPositionBased", { type: "kinematicPositionBased" }, "kinematic"],
  ["kinematicVelocityBased", { type: "kinematicVelocityBased" }, "kinematic"],
  ["KinematicVelocityBased, mixed case", { type: "KinematicVelocityBased" }, "kinematic"],
];

for (const [name, rigidBody, bodyType] of accepted) {
  test(`schema and physics agree on RigidBody ${name}`, async () => {
    assert.deepEqual(validateBuiltInComponent("RigidBody", rigidBody), [], "the schema accepts it");

    const plan = resolveColliderPlan(entityWith(rigidBody));
    assert.equal(plan?.bodyType, bodyType, "the plan builds the documented body type");
    assert.equal(plan?.unsupported, undefined);

    const physics = await createPhysicsWorldFromScene({
      id: stableId("scene", "rigidbody-parity"),
      name: "RigidBody parity",
      entities: [entityWith(rigidBody)],
    });
    try {
      let bodies = 0;
      physics.world.forEachRigidBody(() => {
        bodies += 1;
      });
      assert.equal(bodies, 1, "the world builds it instead of throwing");
    } finally {
      physics.dispose();
    }
  });
}

test("a dynamic body with mass 0 is rejected by the schema and by the world alike", async () => {
  assert.deepEqual(
    validateBuiltInComponent("RigidBody", { type: "dynamic", mass: 0 }).map((issue) => issue.code),
    ["component.RigidBody.mass.invalid"],
  );
  await assert.rejects(
    createPhysicsWorldFromScene({
      id: stableId("scene", "rigidbody-parity-mass"),
      name: "RigidBody parity mass",
      entities: [entityWith({ type: "dynamic", mass: 0 })],
    }),
    RangeError,
  );
});

test("an unknown RigidBody type is rejected by the schema", () => {
  assert.deepEqual(
    validateBuiltInComponent("RigidBody", { type: "ghost" }).map((issue) => issue.code),
    ["component.RigidBody.type.invalid"],
  );
});

test("an entity without a RigidBody is a fixed body in the plan, like a RigidBody with no type", () => {
  assert.equal(resolveColliderPlan(entityWith(undefined))?.bodyType, "fixed");
  assert.equal(resolveColliderPlan(entityWith({}))?.bodyType, "fixed");
});
