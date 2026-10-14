import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEMATISED_COMPONENTS,
  validateBuiltInComponent,
  type EntityDefinition,
  type JsonValue,
} from "@kinetra/project-model";

import {
  BUILT_IN_INSPECTOR_SCHEMAS,
  buildInspector,
  inspectorSchemaDrift,
  type InspectorComponentSchema,
} from "../src/index.js";
import { normalizePropertyPath, setAtPath } from "../src/inspector.js";

function entity(components: Record<string, JsonValue>): EntityDefinition {
  return { id: "e1", name: "Entity", components };
}

function row(model: ReturnType<typeof buildInspector>, component: string, path: string) {
  const found = model.sections.find((section) => section.component === component)?.rows.find((r) => r.path === path);
  assert.ok(found, `row ${component}.${path}`);
  return found;
}

test("number, enum, string and vector rows carry kind, bounds, options and the current value", () => {
  const model = buildInspector(
    entity({
      Transform: { position: [1, 2, 3] },
      Primitive: { kind: "sphere", roughness: 0.25, radius: 2 },
      Model: { assetId: "asset_hero" },
    }),
  );

  const position = row(model, "Transform", "position");
  assert.equal(position.kind, "vector3");
  assert.deepEqual(position.value, [1, 2, 3]);
  assert.equal(position.present, true);
  assert.deepEqual(position.default, [0, 0, 0]);

  const kind = row(model, "Primitive", "kind");
  assert.equal(kind.kind, "enum");
  assert.deepEqual(kind.options, ["box", "sphere", "plane"]);
  assert.equal(kind.value, "sphere");

  const roughness = row(model, "Primitive", "roughness");
  assert.equal(roughness.kind, "number");
  assert.equal(roughness.min, 0);
  assert.equal(roughness.max, 1);
  assert.equal(roughness.value, 0.25);

  assert.equal(row(model, "Primitive", "radius").exclusiveMin, 0);
  assert.equal(row(model, "Model", "assetId").kind, "string");
  assert.equal(row(model, "Model", "assetId").value, "asset_hero");
  assert.equal(model.entityId, "e1");
  assert.equal(model.name, "Entity");
  assert.equal("parentId" in model, false);
});

test("boolean rows come from a custom schema and the parent id is reported", () => {
  const schemas: InspectorComponentSchema[] = [
    { name: "Stats", fields: [{ name: "alive", kind: "boolean", default: true }, { name: "hp", kind: "number", min: 0 }] },
  ];
  const model = buildInspector({ id: "e1", name: "E", parentId: "root", components: { Stats: { alive: false } } }, schemas);
  assert.equal(model.parentId, "root");
  const alive = row(model, "Stats", "alive");
  assert.equal(alive.kind, "boolean");
  assert.equal(alive.value, false);
  assert.equal(alive.default, true);
  const section = model.sections[0];
  assert.equal(section?.known, true);
  assert.deepEqual(section?.rows.map((r) => r.path), ["alive", "hp"]);
});

test("a property the entity does not carry is listed as absent with its default", () => {
  const model = buildInspector(entity({ Camera: { fov: 60 } }));
  const near = row(model, "Camera", "near");
  assert.equal(near.present, false);
  assert.equal(near.value, undefined);
  assert.equal(near.default, 0.1);
  assert.equal(row(model, "Camera", "far").default, 2000);
  const camera = model.sections[0];
  assert.deepEqual(
    camera?.rows.map((r) => r.path),
    ["type", "fov", "aspect", "near", "far"],
    "schema order, not payload order",
  );
});

test("a RigidBody without a type shows the fixed default, and mass only binds a dynamic body", () => {
  const model = buildInspector(entity({ RigidBody: { mass: 0 } }));
  const type = row(model, "RigidBody", "type");
  assert.equal(type.present, false);
  assert.equal(type.default, "fixed");
  // mass 0 is fine for the implicit fixed body: the row carries no issue even though exclusiveMin is 0.
  assert.equal(row(model, "RigidBody", "mass").exclusiveMin, 0);
  assert.equal(row(model, "RigidBody", "mass").issue, undefined);
  assert.deepEqual(validateBuiltInComponent("RigidBody", { mass: 0 }), []);
  // The same mass on an explicit dynamic body is rejected and the issue lands on the mass row.
  const dynamic = buildInspector(entity({ RigidBody: { type: "dynamic", mass: 0 } }));
  assert.equal(row(dynamic, "RigidBody", "mass").issue?.code, "component.RigidBody.mass.invalid");
  // The dynamic check is case-insensitive like the physics factory; kinematic bodies ignore mass.
  const upper = buildInspector(entity({ RigidBody: { type: "Dynamic", mass: 0 } }));
  assert.equal(row(upper, "RigidBody", "mass").issue?.code, "component.RigidBody.mass.invalid");
  const kinematic = buildInspector(entity({ RigidBody: { type: "kinematic", mass: 0 } }));
  assert.equal(row(kinematic, "RigidBody", "mass").issue, undefined);
});

test("a component without a schema is shown raw and every row is flagged unknown", () => {
  const model = buildInspector(entity({ Stats: { hp: 10, name: "orc", boss: true, tags: ["a"], nested: { x: 1 } } }));
  const section = model.sections[0];
  assert.equal(section?.known, false);
  assert.deepEqual(
    section?.rows.map((r) => [r.path, r.kind, r.unknown]),
    [
      ["hp", "number", true],
      ["name", "string", true],
      ["boss", "boolean", true],
      ["tags", "json", true],
      ["nested", "json", true],
    ],
  );
  assert.deepEqual(section?.rows[3]?.value, ["a"]);
});

test("fields a known schema does not describe stay visible and flagged unknown", () => {
  const model = buildInspector(entity({ Light: { kind: "point", custom: 5 } }));
  assert.equal(row(model, "Light", "kind").unknown, false);
  const custom = row(model, "Light", "custom");
  assert.equal(custom.unknown, true);
  assert.equal(custom.value, 5);
});

test("a value the built-in schema rejects carries the structured issue on its row", () => {
  const model = buildInspector(entity({ Primitive: { kind: "torus", roughness: 3 }, Camera: { near: 5, far: 1 } }));
  const kind = row(model, "Primitive", "kind");
  assert.equal(kind.issue?.code, "component.Primitive.kind.invalid");
  assert.match(kind.issue?.remediation ?? "", /box/);
  assert.equal(row(model, "Primitive", "roughness").issue?.code, "component.Primitive.roughness.invalid");
  // The cross-field Camera rule is attached to the field it names.
  assert.equal(row(model, "Camera", "far").issue?.code, "component.Camera.far.invalid");
  assert.equal(row(model, "Primitive", "color").issue, undefined);
});

test("a non-object component is kept raw with a component-level issue, never dropped", () => {
  const model = buildInspector(entity({ Transform: 5, Stats: null, Tags: ["a", "b"], Light: "x" }));
  const byName = Object.fromEntries(model.sections.map((s) => [s.component, s]));
  assert.deepEqual(byName.Transform?.rows, []);
  assert.equal(byName.Transform?.raw, 5);
  assert.equal(byName.Transform?.issues[0]?.code, "component.Transform.invalid");
  assert.equal(byName.Stats?.raw, null);
  assert.equal(byName.Stats?.known, false);
  assert.deepEqual(byName.Tags?.raw, ["a", "b"]);
  assert.equal(byName.Light?.issues[0]?.code, "component.Light.invalid");
});

test("the model is a copy: editing it cannot reach the entity", () => {
  const source = entity({ Transform: { position: [1, 2, 3] }, Stats: { list: [{ a: 1 }] } });
  const model = buildInspector(source);
  (row(model, "Transform", "position").value as number[])[0] = 99;
  ((row(model, "Stats", "list").value as Array<{ a: number }>)[0] as { a: number }).a = 99;
  assert.deepEqual(source.components, { Transform: { position: [1, 2, 3] }, Stats: { list: [{ a: 1 }] } });
});

test("the built-in descriptors cover exactly the schematised components", () => {
  assert.deepEqual(inspectorSchemaDrift(), []);
  assert.deepEqual(inspectorSchemaDrift([]).sort(), SCHEMATISED_COMPONENTS.map((n) => `missing descriptor: ${n}`).sort());
  assert.deepEqual(inspectorSchemaDrift([{ name: "Ghost", fields: [] }]).filter((m) => m.startsWith("no schema")), [
    "no schema: Ghost",
  ]);
});

test("descriptor bounds and options agree with project-model validation", () => {
  // `RigidBody.mass` only has to be positive for a dynamic body (a body with no `type` is fixed and
  // ignores it), so the descriptor's `exclusiveMin` is checked against a dynamic body.
  const accepts = (component: string, field: string, value: JsonValue): boolean =>
    validateBuiltInComponent(component, {
      ...(component === "RigidBody" && field === "mass" ? { type: "dynamic" } : {}),
      [field]: value,
    }).length === 0;

  for (const schema of BUILT_IN_INSPECTOR_SCHEMAS) {
    for (const field of schema.fields) {
      const label = `${schema.name}.${field.name}`;
      if (field.kind === "enum") {
        for (const option of field.options ?? []) assert.ok(accepts(schema.name, field.name, option), `${label} accepts ${option}`);
        assert.ok(!accepts(schema.name, field.name, "__not_an_option__"), `${label} rejects unknown option`);
      }
      if (field.kind === "number") {
        if (field.min !== undefined) {
          assert.ok(accepts(schema.name, field.name, field.min), `${label} accepts min`);
          assert.ok(!accepts(schema.name, field.name, field.min - 1), `${label} rejects below min`);
        }
        if (field.max !== undefined) {
          assert.ok(accepts(schema.name, field.name, field.max), `${label} accepts max`);
          assert.ok(!accepts(schema.name, field.name, field.max + 1), `${label} rejects above max`);
        }
        if (field.exclusiveMin !== undefined) {
          assert.ok(!accepts(schema.name, field.name, field.exclusiveMin), `${label} rejects exclusiveMin itself`);
          assert.ok(accepts(schema.name, field.name, field.exclusiveMin + 0.5), `${label} accepts above exclusiveMin`);
        }
        if (field.exclusiveMax !== undefined) {
          assert.ok(!accepts(schema.name, field.name, field.exclusiveMax), `${label} rejects exclusiveMax itself`);
          assert.ok(accepts(schema.name, field.name, field.exclusiveMax - 0.5), `${label} accepts below exclusiveMax`);
        }
      }
      if (field.kind === "vector3") {
        assert.ok(accepts(schema.name, field.name, [1, 1, 1]), `${label} accepts a vector`);
        assert.ok(!accepts(schema.name, field.name, [1, 1]), `${label} rejects a short vector`);
        if (field.min !== undefined) assert.ok(!accepts(schema.name, field.name, [field.min - 1, 1, 1]), `${label} rejects below min`);
      }
      if (field.default !== undefined) {
        assert.ok(accepts(schema.name, field.name, field.default), `${label} default is itself valid`);
      }
    }
  }
});

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomValue(random: () => number, depth: number): unknown {
  const pick = Math.floor(random() * (depth > 3 ? 9 : 13));
  switch (pick) {
    case 0: return NaN;
    case 1: return null;
    case 2: return Infinity;
    case 3: return -0;
    case 4: return Math.round(random() * 1000) / 10;
    case 5: return random() < 0.5 ? "" : "str" + Math.floor(random() * 100);
    case 6: return random() < 0.5;
    case 7: return undefined;
    case 8: return [random(), random(), random()];
    case 9: return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
    case 10: return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, (_, i) => ["k" + i, randomValue(random, depth + 1)]));
    case 11: return [[[[[[[[1]]]]]]]];
    default: return { __proto__: null, a: randomValue(random, depth + 1) };
  }
}

test("property test: arbitrary component payloads never make buildInspector throw and are deterministic", () => {
  const random = lcg(20261011);
  const names = ["Transform", "Primitive", "Camera", "Light", "Model", "Script", "Stats", "toString", "__proto__"];
  for (let iteration = 0; iteration < 400; iteration += 1) {
    const components: Record<string, JsonValue> = {};
    for (const name of names) {
      if (random() < 0.6) {
        Object.defineProperty(components, name, {
          value: randomValue(random, 0),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    const source = entity(components);
    const first = buildInspector(source);
    const second = buildInspector(source);
    assert.deepEqual(first, second, `iteration ${iteration} is deterministic`);
    assert.equal(first.sections.length, Object.keys(components).length);
    for (const section of first.sections) {
      for (const r of section.rows) assert.equal(typeof r.path, "string");
    }
  }
});

test("a payload structuredClone cannot copy degrades to an empty value instead of throwing", () => {
  const model = buildInspector(entity({ Stats: { fn: (() => 1) as unknown as JsonValue, ok: 1 } }));
  const section = model.sections[0];
  assert.equal(section?.rows.find((r) => r.path === "fn")?.value, undefined);
  assert.equal(section?.rows.find((r) => r.path === "ok")?.value, 1);
  const raw = buildInspector(entity({ Stats: (() => 1) as unknown as JsonValue }));
  assert.equal(raw.sections[0]?.raw, undefined);
});

test("a malformed entity.components does not throw", () => {
  const model = buildInspector({ id: "e", name: "E", components: null as unknown as Record<string, JsonValue> });
  assert.deepEqual(model.sections, []);
});

test("normalizePropertyPath accepts dotted strings and segment arrays and rejects unusable paths", () => {
  assert.deepEqual(normalizePropertyPath("position.1"), ["position", "1"]);
  assert.deepEqual(normalizePropertyPath(["position", 1]), ["position", 1]);
  for (const bad of ["", ".", "a..b", "a.", ".a", "__proto__", "a.__proto__", [], [""], ["a", -1], ["a", 1.5], ["a", NaN]]) {
    assert.equal(normalizePropertyPath(bad as never), undefined, JSON.stringify(bad));
  }
});

test("setAtPath writes copies, appends to arrays, creates missing objects and refuses scalars", () => {
  const original = { list: [1, 2], nested: { a: 1 } } as JsonValue;
  const snapshot = structuredClone(original);

  assert.deepEqual(setAtPath([1, 2, 3], [1], 9), [1, 9, 3]);
  assert.deepEqual(setAtPath([1, 2, 3], ["1"], 9), [1, 9, 3]);
  assert.deepEqual(setAtPath([1, 2], [2], 9), [1, 2, 9], "index === length appends");
  assert.equal(setAtPath([1, 2], [3], 9), undefined, "a gap is refused");
  assert.equal(setAtPath([1, 2], ["x"], 9), undefined, "non-index key on an array");
  assert.deepEqual(setAtPath({ a: 1 }, ["b"], 2), { a: 1, b: 2 });
  assert.deepEqual(setAtPath(undefined, ["b", "c"], 2), { b: { c: 2 } });
  assert.equal(setAtPath(5, ["x"], 1), undefined, "through a scalar");
  assert.equal(setAtPath(null, ["x"], 1), undefined, "through null");
  assert.deepEqual(setAtPath(original, ["nested", "a"], 5), { list: [1, 2], nested: { a: 5 } });
  assert.deepEqual(original, snapshot, "input untouched");
  assert.deepEqual(setAtPath(undefined, [], { z: 1 }), { z: 1 });
  const keyed = setAtPath({}, ["constructor"], 1) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(keyed), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(keyed, "constructor"), true);
});
