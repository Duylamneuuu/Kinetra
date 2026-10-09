import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  ProjectValidationError,
  assertValidProject,
  cloneProject,
  createProject,
  createScene,
  migrateProject,
  newId,
  normalizeProject,
  parseProject,
  serializeProject,
  stableId,
  validateProject,
  type JsonValue,
  type ProjectDocument,
} from "../src/index.js";

function codes(project: unknown): string[] {
  return validateProject(project as ProjectDocument).map((issue) => issue.code);
}

function baseProject(): ProjectDocument {
  const project = createProject({ name: "Contracts", projectId: "project_contracts" });
  const scene = createScene("Main", "scene_main");
  scene.entities.push(
    { id: "e_root", name: "Root", components: { Transform: { position: [0, 1, 2] } } },
    { id: "e_child", name: "Child", parentId: "e_root", components: {} },
  );
  project.scenes.push(scene);
  return project;
}

// --- ids ---------------------------------------------------------------------------

test("stableId is deterministic, kind-prefixed, and rejects an empty seed", () => {
  assert.equal(stableId("entity", "player"), stableId("entity", "player"));
  assert.notEqual(stableId("entity", "player"), stableId("entity", "player2"));
  assert.notEqual(stableId("entity", "player"), stableId("asset", "player"));
  assert.match(stableId("scene", "main"), /^scene_[0-9a-z]+$/);
  assert.match(stableId("prefab", "x"), /^prefab_/);
  assert.throws(() => stableId("entity", ""), /must not be empty/);
});

test("stableId separates 1000 distinct seeds and survives non-ASCII / astral seeds", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 1000; index += 1) {
    seen.add(stableId("entity", `seed-${index}`));
  }
  assert.equal(seen.size, 1000);
  assert.match(stableId("entity", "ngôi sao 🌟"), /^entity_[0-9a-z]+$/);
  assert.notEqual(stableId("entity", "🌟"), stableId("entity", "🌠"));
});

test("newId yields unique ids with the requested kind, with and without crypto.randomUUID", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId("entity")));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^entity_/);

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  try {
    const fallback = new Set(Array.from({ length: 50 }, () => newId("asset")));
    assert.equal(fallback.size, 50);
    for (const id of fallback) assert.match(id, /^asset_/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
});

// --- factory / clone ---------------------------------------------------------------

test("createProject / createScene produce valid empty documents and honour explicit ids", () => {
  const generated = createProject({ name: "Generated" });
  assert.equal(generated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.match(generated.projectId, /^project_/);
  assert.deepEqual(generated.scenes, []);
  assert.deepEqual(validateProject(generated), []);

  assert.equal(createProject({ name: "N", projectId: "fixed" }).projectId, "fixed");
  assert.deepEqual(createScene("S", "scene_fixed"), { id: "scene_fixed", name: "S", entities: [] });
  assert.match(createScene("S").id, /^scene_/);
  assert.notEqual(createScene("S").id, createScene("S").id);
});

test("cloneProject is a deep copy", () => {
  const project = baseProject();
  const copy = cloneProject(project);
  assert.deepEqual(copy, project);
  copy.scenes[0]!.entities[0]!.components.Transform = { position: [9, 9, 9] };
  copy.scenes[0]!.entities.pop();
  assert.deepEqual(project.scenes[0]!.entities[0]!.components.Transform, { position: [0, 1, 2] });
  assert.equal(project.scenes[0]!.entities.length, 2);
});

// --- migration ---------------------------------------------------------------------

test("migrateProject rejects missing / non-numeric / newer / unregistered schema versions", () => {
  for (const input of [null, undefined, 7, "x", [], {}, { schemaVersion: "1" }]) {
    assert.throws(() => migrateProject(input), /missing a numeric schemaVersion/, String(input));
  }
  assert.throws(() => migrateProject({ schemaVersion: 2 }), /newer than supported/);
  assert.throws(() => migrateProject({ schemaVersion: Number.POSITIVE_INFINITY }), /newer than supported/);
  assert.throws(() => migrateProject({ schemaVersion: -1 }), /No migration registered from schema -1/);
  assert.throws(() => migrateProject({ schemaVersion: 0.5 }), /No migration registered from schema 0.5/);
  // NaN skips the migration loop entirely and must still be rejected by validation.
  assert.throws(
    () => migrateProject({ schemaVersion: Number.NaN, projectId: "p", name: "P", scenes: [] }),
    (error: unknown) => error instanceof ProjectValidationError && error.issues[0]!.code === "project.schema.unsupported",
  );
});

test("migrateProject never mutates its input and is idempotent on current documents", () => {
  const legacy = {
    schemaVersion: 0,
    id: "legacy",
    name: "Legacy",
    scenes: [
      {
        id: "s1",
        name: "S1",
        objects: [
          { id: "a", name: "A", components: { Transform: { position: [1, 2, 3] } } },
          { id: "b", name: "B", parent: "a" },
        ],
      },
    ],
  };
  const snapshot = structuredClone(legacy);
  const migrated = migrateProject(legacy);
  assert.deepEqual(legacy, snapshot);

  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.projectId, "legacy");
  assert.deepEqual(migrated.scenes[0]!.entities[0], { id: "a", name: "A", components: { Transform: { position: [1, 2, 3] } } });
  assert.deepEqual(migrated.scenes[0]!.entities[1], { id: "b", name: "B", parentId: "a", components: {} });

  // The migrated components are a copy, not an alias of the legacy object.
  (migrated.scenes[0]!.entities[0]!.components.Transform as { position: number[] }).position[0] = 99;
  assert.deepEqual(legacy, snapshot);

  assert.deepEqual(migrateProject(migrateProject(legacy)), migrateProject(legacy));
});

test("migrateProject v0 tolerates a missing scenes / objects list and rejects malformed ones", () => {
  assert.deepEqual(migrateProject({ schemaVersion: 0, id: "p", name: "P" }).scenes, []);
  assert.deepEqual(
    migrateProject({ schemaVersion: 0, id: "p", name: "P", scenes: [{ id: "s", name: "S" }] }).scenes,
    [{ id: "s", name: "S", entities: [] }],
  );

  const bad: Array<[unknown, RegExp]> = [
    [{ schemaVersion: 0, id: "p", name: "P", scenes: "nope" }, /scenes must be an array/],
    [{ schemaVersion: 0, id: "p", name: "P", scenes: [7] }, /scenes\[0\] must be an object/],
    [{ schemaVersion: 0, id: "p", name: "P", scenes: [{ id: "s", name: "S", objects: {} }] }, /scenes\[0\]\.objects must be an array/],
    [{ schemaVersion: 0, id: "p", name: "P", scenes: [{ id: "s", name: "S", objects: [null] }] }, /objects\[0\] must be an object/],
  ];
  for (const [input, pattern] of bad) {
    assert.throws(() => migrateProject(input), pattern);
  }
});

test("migrateProject v0 documents that migrate to an invalid project surface structured issues", () => {
  assert.throws(
    () =>
      migrateProject({
        schemaVersion: 0,
        id: "p",
        name: "P",
        scenes: [{ id: "s", name: "S", objects: [{ id: "a", name: "A", parent: "ghost" }] }],
      }),
    (error: unknown) =>
      error instanceof ProjectValidationError && error.issues.some((issue) => issue.code === "entity.parent.missing"),
  );
});

// --- validation --------------------------------------------------------------------

test("validateProject reports every top-level shape problem, never throws", () => {
  for (const input of [null, undefined, 3, "x", []]) {
    assert.deepEqual(codes(input), ["project.invalid"], String(input));
  }
  assert.deepEqual(codes({ schemaVersion: 2, projectId: "p", name: "P", scenes: [] }), ["project.schema.unsupported"]);
  assert.deepEqual(
    codes({ schemaVersion: 1, projectId: "", name: "", scenes: [] }).sort(),
    ["project.id.empty", "project.name.empty"],
  );
});

test("validateProject: scene id problems (empty, duplicate) and issue paths", () => {
  const project = baseProject();
  project.scenes.push({ id: "scene_main", name: "Dup", entities: [] }, { id: "", name: "Empty", entities: [] });
  const issues = validateProject(project);
  assert.deepEqual(
    issues.map((issue) => [issue.path, issue.code]),
    [
      ["scenes[1].id", "scene.id.duplicate"],
      ["scenes[2].id", "scene.id.empty"],
    ],
  );
});

test("validateProject: entity field problems carry precise paths", () => {
  const project = baseProject();
  project.scenes[0]!.entities.push(
    { id: "", name: "", components: null as unknown as Record<string, JsonValue> },
    { id: "e_arr", name: "Arr", components: [] as unknown as Record<string, JsonValue> },
    { id: "e_empty_parent", name: "P", parentId: "", components: {} },
    { id: "e_num_parent", name: "P", parentId: 5 as unknown as string, components: {} },
    { id: "e_ghost", name: "G", parentId: "nowhere", components: {} },
  );
  const found = new Map(validateProject(project).map((issue) => [`${issue.path}|${issue.code}`, issue.message]));
  for (const key of [
    "scenes[0].entities[2].id|entity.id.empty",
    "scenes[0].entities[2].name|entity.name.empty",
    "scenes[0].entities[2].components|entity.components.invalid",
    "scenes[0].entities[3].components|entity.components.invalid",
    "scenes[0].entities[4].parentId|entity.parent.invalid",
    "scenes[0].entities[5].parentId|entity.parent.invalid",
    "scenes[0].entities[6].parentId|entity.parent.missing",
  ]) {
    assert.ok(found.has(key), `missing ${key}; got ${[...found.keys()].join(", ")}`);
  }
  assert.match(found.get("scenes[0].entities[6].parentId|entity.parent.missing")!, /nowhere.*scene_main/);
});

test("validateProject: duplicate entity ids are caught per scene and across scenes", () => {
  const project = baseProject();
  project.scenes[0]!.entities.push({ id: "e_root", name: "Again", components: {} });
  const second = createScene("Second", "scene_second");
  second.entities.push({ id: "e_child", name: "Reused", components: {} });
  project.scenes.push(second);
  const found = validateProject(project).map((issue) => `${issue.path}|${issue.code}`);
  assert.ok(found.includes("scenes[0].entities[2].id|entity.id.duplicate-in-scene"));
  assert.ok(found.includes("scenes[0].entities[2].id|entity.id.duplicate-in-project"));
  assert.ok(found.includes("scenes[1].entities[0].id|entity.id.duplicate-in-project"));
  assert.ok(!found.includes("scenes[1].entities[0].id|entity.id.duplicate-in-scene"));
});

test("validateProject: empty component names and non-JSON component values", () => {
  const project = baseProject();
  const entity = project.scenes[0]!.entities[0]!;
  entity.components[""] = { ok: true };
  entity.components.Bad = Number.NaN as unknown as JsonValue;
  entity.components.Inf = { nested: [Number.POSITIVE_INFINITY] } as unknown as JsonValue;
  entity.components.Fn = (() => 1) as unknown as JsonValue;
  entity.components.Undef = undefined as unknown as JsonValue;
  entity.components.Date = new Date(0) as unknown as JsonValue;
  entity.components.Fine = { deep: [1, "two", null, { three: true }] };
  const found = validateProject(project).map((issue) => `${issue.path}|${issue.code}`);
  assert.deepEqual(
    found.sort(),
    [
      "scenes[0].entities[0].components.Bad|component.value.not-json",
      "scenes[0].entities[0].components.Date|component.value.not-json",
      "scenes[0].entities[0].components.Fn|component.value.not-json",
      "scenes[0].entities[0].components.Inf|component.value.not-json",
      "scenes[0].entities[0].components.Undef|component.value.not-json",
      "scenes[0].entities[0].components|component.name.empty",
    ].sort(),
  );
});

test("validateProject: self-parent, long chains and cross-cycles", () => {
  const project = baseProject();
  const entities = project.scenes[0]!.entities;
  entities.push({ id: "e_self", name: "Self", parentId: "e_self", components: {} });
  const cycle = validateProject(project).filter((issue) => issue.code === "entity.parent.cycle");
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0]!.path, "scenes[scene_main].entities[e_self].parentId");

  // A 5,000-deep chain is fine (no recursion); closing it into a ring reports every member once.
  const chain = createProject({ name: "Chain", projectId: "chain" });
  const scene = createScene("S", "s");
  const depth = 5000;
  for (let index = 0; index < depth; index += 1) {
    scene.entities.push({
      id: `n${index}`,
      name: `N${index}`,
      ...(index > 0 ? { parentId: `n${index - 1}` } : {}),
      components: {},
    });
  }
  chain.scenes.push(scene);
  assert.deepEqual(validateProject(chain), []);
  scene.entities[0]!.parentId = `n${depth - 1}`;
  const ring = validateProject(chain).filter((issue) => issue.code === "entity.parent.cycle");
  assert.equal(ring.length, depth);
});

test("validateProject: metadata must be a plain JSON object", () => {
  const withMetadata = (metadata: unknown): string[] =>
    codes({ ...baseProject(), metadata });
  assert.deepEqual(withMetadata({ a: 1, nested: { b: [true, null] } }), []);
  for (const bad of [[], "x", 5, null, new Map(), { f: () => 1 }, { n: Number.NaN }]) {
    assert.deepEqual(withMetadata(bad), ["project.metadata.not-json"], String(bad));
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.deepEqual(withMetadata(cyclic), ["project.metadata.not-json"]);
});

test("assertValidProject throws ProjectValidationError with a pluralised message and exposes issues", () => {
  const project = baseProject();
  assertValidProject(project);

  project.name = "";
  assert.throws(
    () => assertValidProject(project),
    (error: unknown) =>
      error instanceof ProjectValidationError &&
      error.name === "ProjectValidationError" &&
      error.message === "Project validation failed with 1 issue" &&
      error.issues.length === 1,
  );

  project.projectId = "";
  assert.throws(
    () => assertValidProject(project),
    (error: unknown) => error instanceof ProjectValidationError && error.message === "Project validation failed with 2 issues",
  );
});

// --- serialization -----------------------------------------------------------------

test("serialization preserves a JSON '__proto__' key instead of silently dropping it", () => {
  const text = JSON.stringify({
    schemaVersion: 1,
    projectId: "p",
    name: "P",
    scenes: [
      {
        id: "s",
        name: "S",
        entities: [{ id: "e", name: "E", components: { Tag: { z: 1, a: 2 } } }],
      },
    ],
    metadata: { k: 1 },
  }).replace('"Tag":{"z":1,"a":2}', '"Tag":{"z":1,"a":2,"__proto__":{"deep":true}},"__proto__":{"top":1}').replace(
    '"metadata":{"k":1}',
    '"metadata":{"k":1,"__proto__":{"m":2}}',
  );

  const parsed = parseProject(text);
  const serialized = serializeProject(parsed);
  const reparsed = parseProject(serialized);

  const components = reparsed.scenes[0]!.entities[0]!.components;
  assert.deepEqual(Object.keys(components).sort(), ["Tag", "__proto__"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(components, "__proto__")!.value, { top: 1 });
  assert.deepEqual(
    Object.keys(components.Tag as object).sort(),
    ["__proto__", "a", "z"],
  );
  assert.deepEqual(Object.keys(reparsed.metadata!).sort(), ["__proto__", "k"]);

  // No prototype pollution of the result or of Object.prototype, and serialization is a fixed point.
  assert.equal(Object.getPrototypeOf(components), Object.prototype);
  assert.equal(({} as Record<string, unknown>).top, undefined);
  assert.equal(serializeProject(reparsed), serialized);
});

test("normalizeProject sorts without mutating the input and is idempotent", () => {
  const project = baseProject();
  project.scenes.push({ id: "scene_a", name: "A", entities: [] });
  project.scenes[0]!.entities.reverse();
  project.metadata = { z: 1, a: { y: 1, b: 2 } };
  const before = structuredClone(project);

  const normalized = normalizeProject(project);
  assert.deepEqual(project, before);
  assert.deepEqual(normalized.scenes.map((scene) => scene.id), ["scene_a", "scene_main"]);
  assert.deepEqual(normalized.scenes[1]!.entities.map((entity) => entity.id), ["e_child", "e_root"]);
  assert.deepEqual(Object.keys(normalized.metadata!), ["a", "z"]);
  assert.deepEqual(Object.keys(normalized.metadata!.a as object), ["b", "y"]);
  assert.deepEqual(normalizeProject(normalized), normalized);
  assert.notEqual(normalized, project);
});

test("normalizeProject refuses invalid documents", () => {
  const project = baseProject();
  project.scenes[0]!.entities[1]!.parentId = "e_child";
  assert.throws(() => normalizeProject(project), ProjectValidationError);
  assert.throws(() => serializeProject(project), ProjectValidationError);
});

test("serializeProject ends with a newline, uses 2-space indent and round-trips through parseProject", () => {
  const text = serializeProject(baseProject());
  assert.ok(text.endsWith("}\n"));
  assert.ok(text.startsWith('{\n  "schemaVersion": 1,'));
  assert.deepEqual(parseProject(text), normalizeProject(baseProject()));
});

test("parseProject surfaces JSON syntax errors and non-object roots", () => {
  assert.throws(() => parseProject("{not json"), SyntaxError);
  assert.throws(() => parseProject("[]"), /missing a numeric schemaVersion/);
  assert.throws(() => parseProject("null"), /missing a numeric schemaVersion/);
});

test("seeded round-trip fuzz: random valid projects survive serialize → parse → serialize unchanged", () => {
  let state = 0x9e3779b9;
  const random = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const keys = ["a", "B", "z", "é", "__proto__", "constructor", "10", "2", "toString", "😀", " "];

  const randomJson = (depth: number): JsonValue => {
    const kind = Math.floor(random() * (depth > 3 ? 4 : 6));
    switch (kind) {
      case 0:
        return null;
      case 1:
        return random() < 0.5;
      case 2:
        return Math.round((random() - 0.5) * 1e6) / 1e3;
      case 3:
        return pick(["", "x", "ngôi", "\u0000", "line\nbreak"]);
      case 4:
        return Array.from({ length: Math.floor(random() * 4) }, () => randomJson(depth + 1));
      default: {
        const object: Record<string, JsonValue> = {};
        for (let count = Math.floor(random() * 4); count > 0; count -= 1) {
          Object.defineProperty(object, pick(keys), {
            value: randomJson(depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return object;
      }
    }
  };

  for (let seed = 0; seed < 150; seed += 1) {
    const project = createProject({ name: `Fuzz ${seed}`, projectId: `fuzz_${seed}` });
    let entityCounter = 0;
    for (let sceneIndex = Math.floor(random() * 3); sceneIndex >= 0; sceneIndex -= 1) {
      const scene = createScene(`S${sceneIndex}`, `scene_${seed}_${sceneIndex}`);
      for (let count = Math.floor(random() * 6); count > 0; count -= 1) {
        const id = `e_${seed}_${entityCounter++}`;
        const parent = scene.entities.length > 0 && random() < 0.5 ? pick(scene.entities).id : undefined;
        const components: Record<string, JsonValue> = {};
        for (let c = Math.floor(random() * 3); c > 0; c -= 1) {
          Object.defineProperty(components, pick(keys), {
            value: randomJson(0),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        scene.entities.push({ id, name: id, ...(parent ? { parentId: parent } : {}), components });
      }
      project.scenes.push(scene);
    }
    if (random() < 0.5) {
      const metadata = randomJson(1);
      if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) project.metadata = metadata;
    }

    assert.deepEqual(validateProject(project), [], `seed ${seed}`);
    const first = serializeProject(project);
    const parsed = parseProject(first);
    assert.deepEqual(parsed, normalizeProject(project), `seed ${seed}: parse(serialize(x)) must equal normalize(x)`);
    assert.equal(serializeProject(parsed), first, `seed ${seed}: serialize must be a fixed point`);
  }
});
