import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COLLIDER_LAYER,
  SCHEMATISED_COMPONENTS,
  validateBuiltInComponent,
  validateProject,
  type ProjectDocument,
} from "../src/index.js";

function codes(name: string, value: unknown): string[] {
  return validateBuiltInComponent(name, value).map((issue) => issue.code);
}

test("Collider, RigidBody, CharacterBody and NavMesh are schematised", () => {
  for (const name of ["Collider", "RigidBody", "CharacterBody", "NavMesh"]) {
    assert.ok(SCHEMATISED_COMPONENTS.includes(name), name);
    assert.deepEqual(validateBuiltInComponent(name, {}), [], `${name} {} uses the defaults`);
  }
});

test("valid Collider payloads pass and unknown fields stay free-form", () => {
  assert.deepEqual(codes("Collider", { shape: "box", size: [1, 2, 3], friction: 0.5, restitution: 0 }), []);
  assert.deepEqual(codes("Collider", { shape: "box", halfExtents: [0.5, 0.5, 0.5], layer: 0 }), []);
  assert.deepEqual(codes("Collider", { shape: "capsule", radius: 0.4, halfHeight: 0.5, layer: MAX_COLLIDER_LAYER }), []);
  assert.deepEqual(codes("Collider", { shape: "sphere", radius: 2, isTrigger: true, tags: ["a"] }), []);
  // The physics factory warns about (rather than rejects) shapes it cannot build.
  assert.deepEqual(codes("Collider", { shape: "mesh" }), []);
});

test("Collider rejects malformed fields with a remediation each", () => {
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ shape: 12 }, "component.Collider.shape.invalid"],
    [{ shape: "" }, "component.Collider.shape.invalid"],
    [{ size: [1, 2] }, "component.Collider.size.invalid"],
    [{ size: [1, -2, 3] }, "component.Collider.size.invalid"],
    [{ halfExtents: [1, Number.NaN, 1] }, "component.Collider.halfExtents.invalid"],
    [{ radius: 0 }, "component.Collider.radius.invalid"],
    [{ radius: "1" }, "component.Collider.radius.invalid"],
    [{ halfHeight: -1 }, "component.Collider.halfHeight.invalid"],
    [{ friction: -0.1 }, "component.Collider.friction.invalid"],
    [{ restitution: Number.POSITIVE_INFINITY }, "component.Collider.restitution.invalid"],
    [{ layer: 1.5 }, "component.Collider.layer.invalid"],
    [{ layer: -1 }, "component.Collider.layer.invalid"],
    [{ layer: MAX_COLLIDER_LAYER + 1 }, "component.Collider.layer.invalid"],
  ];
  for (const [value, code] of bad) {
    const issues = validateBuiltInComponent("Collider", value);
    assert.deepEqual(issues.map((issue) => issue.code), [code], JSON.stringify(value));
    assert.ok((issues[0]?.remediation ?? "").length > 0, code);
  }
});

test("RigidBody type is checked case-insensitively like the runtime does", () => {
  for (const type of ["fixed", "static", "dynamic", "kinematic", "kinematicPositionBased", "Dynamic", "KINEMATICVELOCITYBASED"]) {
    assert.deepEqual(codes("RigidBody", { type }), [], type);
  }
  assert.deepEqual(codes("RigidBody", { type: "ghost" }), ["component.RigidBody.type.invalid"]);
  assert.deepEqual(codes("RigidBody", { type: 3 }), ["component.RigidBody.type.invalid"]);
  assert.deepEqual(codes("RigidBody", { type: "dynamic", mass: 2, gravityScale: 0, linearDamping: 0.1, angularDamping: 0 }), []);
  assert.deepEqual(codes("RigidBody", { mass: 0 }), ["component.RigidBody.mass.invalid"]);
  assert.deepEqual(codes("RigidBody", { mass: -3 }), ["component.RigidBody.mass.invalid"]);
  assert.deepEqual(codes("RigidBody", { gravityScale: Number.NaN }), ["component.RigidBody.gravityScale.invalid"]);
  assert.deepEqual(codes("RigidBody", { linearDamping: -1 }), ["component.RigidBody.linearDamping.invalid"]);
  assert.deepEqual(codes("RigidBody", { angularDamping: "x" }), ["component.RigidBody.angularDamping.invalid"]);
  const issues = validateBuiltInComponent("RigidBody", { type: "ghost" });
  assert.match(issues[0]?.remediation ?? "", /Fix RigidBody\.type/);
});

test("CharacterBody fields are finite and non-negative", () => {
  assert.deepEqual(codes("CharacterBody", { speed: 5, offset: 0.01, autostepMaxHeight: 0.3, autostepMinWidth: 0.2 }), []);
  assert.deepEqual(codes("CharacterBody", { speed: -1 }), ["component.CharacterBody.speed.invalid"]);
  assert.deepEqual(codes("CharacterBody", { offset: Number.NaN }), ["component.CharacterBody.offset.invalid"]);
  assert.deepEqual(codes("CharacterBody", { autostepMaxHeight: "1" }), ["component.CharacterBody.autostepMaxHeight.invalid"]);
  assert.deepEqual(codes("CharacterBody", { autostepMinWidth: -0.5 }), ["component.CharacterBody.autostepMinWidth.invalid"]);
});

test("NavMesh geometry must be well-formed triangles", () => {
  const good = { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] };
  assert.deepEqual(codes("NavMesh", good), []);
  assert.deepEqual(codes("NavMesh", { ...good, config: { cellSize: 0.3 } }), []);
  assert.deepEqual(codes("NavMesh", { dataBase64: "AAEC" }), []);
  assert.deepEqual(codes("NavMesh", { positions: [], indices: [] }), []);

  assert.deepEqual(codes("NavMesh", { ...good, positions: [0, 0, 0, 1] }), ["component.NavMesh.positions.invalid"]);
  assert.deepEqual(codes("NavMesh", { ...good, positions: "nope" }), ["component.NavMesh.positions.invalid"]);
  assert.deepEqual(codes("NavMesh", { ...good, positions: [0, 0, Number.NaN, 1, 0, 0, 0, 0, 1] }), [
    "component.NavMesh.positions.invalid",
  ]);
  assert.deepEqual(codes("NavMesh", { ...good, indices: [0, 1] }), ["component.NavMesh.indices.invalid"]);
  assert.deepEqual(codes("NavMesh", { ...good, indices: [0, 1.5, 2] }), ["component.NavMesh.indices.invalid"]);
  assert.deepEqual(codes("NavMesh", { ...good, indices: [0, -1, 2] }), ["component.NavMesh.indices.invalid"]);
  assert.deepEqual(codes("NavMesh", { ...good, config: [1] }), ["component.NavMesh.config.invalid"]);
  assert.deepEqual(codes("NavMesh", { dataBase64: "" }), ["component.NavMesh.dataBase64.invalid"]);
  assert.deepEqual(codes("NavMesh", { dataBase64: 7 }), ["component.NavMesh.dataBase64.invalid"]);
});

test("NavMesh indices must point at existing vertices", () => {
  const issues = validateBuiltInComponent("NavMesh", {
    positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
    indices: [0, 1, 3],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "component.NavMesh.indices.outOfRange");
  assert.equal(issues[0]?.field, "indices");
  assert.match(issues[0]?.message ?? "", /indices\[2\]/);
  assert.ok((issues[0]?.remediation ?? "").length > 0);
  // The relation is skipped when an individual field is already wrong.
  assert.deepEqual(codes("NavMesh", { positions: [0, 0], indices: [0, 1, 99] }), [
    "component.NavMesh.positions.invalid",
  ]);
  // Indices without positions (dataBase64-only meshes never carry them) are not cross-checked.
  assert.deepEqual(codes("NavMesh", { indices: [0, 1, 99] }), []);
});

test("non-object payloads and hostile values never throw", () => {
  for (const name of ["Collider", "RigidBody", "CharacterBody", "NavMesh"]) {
    for (const value of [null, undefined, 4, "x", true, [], [1, 2, 3]]) {
      const issues = validateBuiltInComponent(name, value);
      assert.equal(issues.length, 1, `${name} ${JSON.stringify(value)}`);
      assert.equal(issues[0]?.code, `component.${name}.invalid`);
      assert.ok((issues[0]?.remediation ?? "").length > 0);
    }
  }

  const hostile = JSON.parse(
    '{"__proto__":{"shape":5},"constructor":{"prototype":{"radius":-1}},"radius":1}',
  ) as unknown;
  assert.deepEqual(codes("Collider", hostile), []);
  assert.equal(({} as Record<string, unknown>).shape, undefined, "prototype stays clean");

  assert.deepEqual(codes("NavMesh", { positions: [0, 0, 0], indices: [Number.MAX_SAFE_INTEGER, 0, 0] }), [
    "component.NavMesh.indices.outOfRange",
  ]);
  assert.deepEqual(codes("RigidBody", { type: { toString: 1 } }), ["component.RigidBody.type.invalid"]);
});

test("validateProject reports an invalid physics component at its entity path", () => {
  const project: ProjectDocument = {
    schemaVersion: 1,
    projectId: "project_physics",
    name: "Physics",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [
          {
            id: "e_ok",
            name: "Ok",
            components: {
              RigidBody: { type: "dynamic", mass: 1 },
              Collider: { shape: "box", size: [1, 1, 1], layer: 2 },
              CharacterBody: { speed: 3 },
              NavMesh: { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] },
            } as never,
          },
          {
            id: "e_bad",
            name: "Bad",
            components: { Collider: { radius: -2 }, RigidBody: { mass: 0 } } as never,
          },
        ],
      },
    ],
  };
  const issues = validateProject(project);
  assert.deepEqual(
    issues.map((issue) => issue.code).sort(),
    ["component.Collider.radius.invalid", "component.RigidBody.mass.invalid"],
  );
  assert.ok(
    issues.every((issue) => /\.components\.(Collider\.radius|RigidBody\.mass)$/.test(issue.path)),
    JSON.stringify(issues.map((issue) => issue.path)),
  );
  assert.ok(issues.every((issue) => (issue.remediation ?? "").length > 0));
});
