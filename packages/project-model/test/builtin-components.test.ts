import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEMATISED_COMPONENTS,
  ProjectValidationError,
  assertValidProject,
  validateBuiltInComponent,
  validateProject,
  type ProjectDocument,
} from "../src/index.js";

function projectWith(components: Record<string, unknown>): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_builtin",
    name: "Builtin",
    scenes: [
      {
        id: "scene_main",
        name: "Main",
        entities: [{ id: "e_one", name: "One", components: components as never }],
      },
    ],
  };
}

function problems(name: string, value: unknown): string[] {
  return validateBuiltInComponent(name, value).map((issue) => issue.code);
}

test("components without a schema are never inspected", () => {
  assert.deepEqual(validateBuiltInComponent("Collider", { shape: 12 }), []);
  assert.deepEqual(validateBuiltInComponent("MyCustom", "anything"), []);
  assert.deepEqual(validateBuiltInComponent("__proto__", { a: 1 }), []);
  assert.deepEqual(validateBuiltInComponent("constructor", 3), []);
  assert.deepEqual(validateBuiltInComponent("toString", null), []);
});

test("schematised component list covers the runtime built-ins", () => {
  for (const name of ["Transform", "Primitive", "Camera", "Light", "Model", "Script"]) {
    assert.ok(SCHEMATISED_COMPONENTS.includes(name), name);
  }
});

test("empty and fully-defaulted built-ins are valid", () => {
  for (const name of SCHEMATISED_COMPONENTS) {
    assert.deepEqual(validateBuiltInComponent(name, {}), [], name);
  }
});

test("unknown fields stay free-form", () => {
  assert.deepEqual(validateBuiltInComponent("Transform", { x: 4, tag: "a", nested: { y: [1] } }), []);
  assert.deepEqual(validateBuiltInComponent("Primitive", { kind: "box", castShadow: true }), []);
});

test("non-object built-in values are rejected with a component-level issue", () => {
  for (const value of [null, 3, "box", true, [1, 2, 3]]) {
    const issues = validateBuiltInComponent("Primitive", value);
    assert.equal(issues.length, 1, JSON.stringify(value));
    assert.equal(issues[0]?.code, "component.Primitive.invalid");
    assert.equal(issues[0]?.field, "");
    assert.ok((issues[0]?.remediation ?? "").length > 0);
  }
});

test("Transform vectors must be exactly three finite numbers", () => {
  assert.deepEqual(problems("Transform", { position: [0, 1, 2], rotation: [0, 0, 0], scale: [1, 1, 1] }), []);
  assert.deepEqual(problems("Transform", { position: [0, 1] }), ["component.Transform.position.invalid"]);
  assert.deepEqual(problems("Transform", { position: [0, 1, 2, 3] }), ["component.Transform.position.invalid"]);
  assert.deepEqual(problems("Transform", { rotation: [0, "1", 2] }), ["component.Transform.rotation.invalid"]);
  assert.deepEqual(problems("Transform", { scale: "big" }), ["component.Transform.scale.invalid"]);
  assert.deepEqual(problems("Transform", { scale: null }), ["component.Transform.scale.invalid"]);
  assert.deepEqual(problems("Transform", { position: [Number.NaN, 0, 0] }), [
    "component.Transform.position.invalid",
  ]);
  assert.deepEqual(problems("Transform", { position: [Infinity, 0, 0] }), [
    "component.Transform.position.invalid",
  ]);
  assert.deepEqual(problems("Transform", { position: {}, scale: [1] }), [
    "component.Transform.position.invalid",
    "component.Transform.scale.invalid",
  ]);
});

test("Primitive.kind is limited to what the renderer can build", () => {
  for (const kind of ["box", "sphere", "plane"]) {
    assert.deepEqual(problems("Primitive", { kind }), [], kind);
  }
  const issues = validateBuiltInComponent("Primitive", { kind: "cylinder" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "component.Primitive.kind.invalid");
  assert.equal(issues[0]?.field, "kind");
  assert.match(issues[0]?.remediation ?? "", /box, sphere, plane/);
  assert.deepEqual(problems("Primitive", { kind: 3 }), ["component.Primitive.kind.invalid"]);
  assert.deepEqual(problems("Primitive", { kind: "Box" }), ["component.Primitive.kind.invalid"]);
});

test("Primitive numeric fields are bounded", () => {
  assert.deepEqual(
    problems("Primitive", {
      kind: "sphere",
      color: "#ff8800",
      roughness: 0,
      metalness: 1,
      radius: 0.25,
      segments: 16,
    }),
    [],
  );
  assert.deepEqual(problems("Primitive", { size: [1, 1] }), ["component.Primitive.size.invalid"]);
  assert.deepEqual(problems("Primitive", { size: [1, -1, 1] }), ["component.Primitive.size.invalid"]);
  assert.deepEqual(problems("Primitive", { size: [0, 0, 0] }), []);
  assert.deepEqual(problems("Primitive", { radius: 0 }), ["component.Primitive.radius.invalid"]);
  assert.deepEqual(problems("Primitive", { radius: -2 }), ["component.Primitive.radius.invalid"]);
  assert.deepEqual(problems("Primitive", { width: 0, height: -1 }), [
    "component.Primitive.width.invalid",
    "component.Primitive.height.invalid",
  ]);
  assert.deepEqual(problems("Primitive", { roughness: 1.5 }), ["component.Primitive.roughness.invalid"]);
  assert.deepEqual(problems("Primitive", { metalness: -0.1 }), ["component.Primitive.metalness.invalid"]);
  assert.deepEqual(problems("Primitive", { segments: 0 }), ["component.Primitive.segments.invalid"]);
  assert.deepEqual(problems("Primitive", { color: "" }), ["component.Primitive.color.invalid"]);
  assert.deepEqual(problems("Primitive", { color: 16711680 }), ["component.Primitive.color.invalid"]);
});

test("Camera fields: type, fov range, near/far ordering", () => {
  assert.deepEqual(problems("Camera", { type: "perspective", fov: 75, aspect: 1.5, near: 0.01, far: 500 }), []);
  assert.deepEqual(problems("Camera", { type: "orthographic" }), ["component.Camera.type.invalid"]);
  assert.deepEqual(problems("Camera", { fov: 0 }), ["component.Camera.fov.invalid"]);
  assert.deepEqual(problems("Camera", { fov: 180 }), ["component.Camera.fov.invalid"]);
  assert.deepEqual(problems("Camera", { aspect: 0 }), ["component.Camera.aspect.invalid"]);
  assert.deepEqual(problems("Camera", { near: -1 }), ["component.Camera.near.invalid"]);
  assert.deepEqual(problems("Camera", { near: 10, far: 5 }), ["component.Camera.far.invalid"]);
  assert.deepEqual(problems("Camera", { near: 10, far: 10 }), ["component.Camera.far.invalid"]);
  // Defaults are 0.1 / 2000: a lone far below the default near, or lone near above the default far, is wrong too.
  assert.deepEqual(problems("Camera", { far: 0.05 }), ["component.Camera.far.invalid"]);
  assert.deepEqual(problems("Camera", { near: 3000 }), ["component.Camera.far.invalid"]);
});

test("Light, Model and Script fields", () => {
  assert.deepEqual(problems("Light", { kind: "point", color: "#ffffff", intensity: 0 }), []);
  assert.deepEqual(problems("Light", { kind: "spot" }), ["component.Light.kind.invalid"]);
  assert.deepEqual(problems("Light", { intensity: -1 }), ["component.Light.intensity.invalid"]);
  assert.deepEqual(problems("Light", { intensity: "bright" }), ["component.Light.intensity.invalid"]);
  assert.deepEqual(problems("Model", { assetId: "asset_hero" }), []);
  assert.deepEqual(problems("Model", { assetId: "" }), ["component.Model.assetId.invalid"]);
  assert.deepEqual(problems("Model", { assetId: 7 }), ["component.Model.assetId.invalid"]);
  assert.deepEqual(problems("Script", { scriptId: "player", order: -10 }), []);
  assert.deepEqual(problems("Script", { scriptId: "" }), ["component.Script.scriptId.invalid"]);
  assert.deepEqual(problems("Script", { order: Number.NaN }), ["component.Script.order.invalid"]);
});

test("validateBuiltInComponent never throws on hostile input", () => {
  const hostile: unknown[] = [
    undefined,
    Symbol("x"),
    () => 1,
    new Map(),
    Object.create(null),
    JSON.parse('{"__proto__": {"kind": "cylinder"}}'),
    JSON.parse('{"kind": "__proto__"}'),
    { get kind(): string { return "box"; } },
  ];
  for (const name of SCHEMATISED_COMPONENTS) {
    for (const value of hostile) {
      assert.doesNotThrow(() => validateBuiltInComponent(name, value));
    }
  }
});

test("validateProject reports built-in issues at the field path with a remediation", () => {
  const issues = validateProject(
    projectWith({
      Primitive: { kind: "cylinder" },
      Transform: { position: [0, 1] },
      Collider: { shape: "anything" },
    }),
  );
  assert.deepEqual(
    issues.map((issue) => [issue.path, issue.code]),
    [
      ["scenes[0].entities[0].components.Primitive.kind", "component.Primitive.kind.invalid"],
      ["scenes[0].entities[0].components.Transform.position", "component.Transform.position.invalid"],
    ],
  );
  for (const issue of issues) {
    assert.ok(issue.remediation && issue.remediation.length > 0);
  }
});

test("component-level issue path has no trailing dot", () => {
  const [issue] = validateProject(projectWith({ Light: 5 }));
  assert.equal(issue?.path, "scenes[0].entities[0].components.Light");
  assert.equal(issue?.code, "component.Light.invalid");
});

test("non-JSON values report only the JSON issue, not built-in issues", () => {
  const issues = validateProject(projectWith({ Transform: { position: [Number.NaN, 0, 0] } }));
  // NaN is not JSON, so the existing JSON rule fires and the schema rule stays quiet.
  assert.deepEqual(issues.map((issue) => issue.code), ["component.value.not-json"]);
});

test("assertValidProject throws ProjectValidationError carrying every issue", () => {
  assert.throws(
    () => assertValidProject(projectWith({ Camera: { fov: 400 }, Light: { kind: "spot" } })),
    (error: unknown) => {
      assert.ok(error instanceof ProjectValidationError);
      assert.deepEqual(error.issues.map((issue) => issue.code), [
        "component.Camera.fov.invalid",
        "component.Light.kind.invalid",
      ]);
      return true;
    },
  );
});

test("valid projects with every built-in still validate", () => {
  assert.deepEqual(
    validateProject(
      projectWith({
        Transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        Primitive: { kind: "box", size: [1, 2, 3], color: "#abcdef" },
        Script: { scriptId: "s", order: 0 },
      }),
    ),
    [],
  );
});
