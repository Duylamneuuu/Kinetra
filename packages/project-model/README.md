# @kinetra/project-model

Versioned text authoring schemas, stable IDs, scene/prefab/build/input/test data and migrations.

A Kinetra project is a plain JSON `ProjectDocument` (`schemaVersion`, `projectId`, `name`, `scenes[]`, optional `metadata`). Scenes hold entities; entities hold a `components` map of JSON values and an optional `parentId`. This package creates, validates, normalizes, serializes and migrates that document. It has no engine or renderer dependencies. Mutations at authoring time go through `@kinetra/command-bus`, not by editing the document directly.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `createProject({ name, projectId? })`, `createScene(name, sceneId?)` | factories | Empty schema-v1 project / scene. Ids default to `newId(...)`. |
| `stableId(kind, seed)` | function | Deterministic id (`scene_<hash>`) from a non-empty seed; same seed, same id. `kind` is `project`, `scene`, `entity`, `asset`, `prefab` or `test`. |
| `newId(kind)` | function | Fresh random id with the same `kind_` prefix. |
| `validateProject(project)` | function | Returns `ValidationIssue[]` (`path`, `code`, `message`); empty means valid. Safe on untrusted documents. |
| `assertValidProject(project)` | function | Throws `ProjectValidationError` (with `.issues`) when invalid. |
| `normalizeProject(project)` | function | Deep copy with scenes/entities sorted by id (locale-independent), component/metadata keys sorted, and envelope keys in schema order (`schemaVersion, projectId, name, scenes, metadata`; scene `id, name, entities`; entity `id, name, parentId, components`; unknown keys after them, sorted). The same project serializes to the same bytes whatever order its properties were assigned in. |
| `serializeProject(project)` / `parseProject(text)` | functions | Canonical, diff-friendly JSON text (2-space indent, trailing newline), and the inverse including migration. JSON `"__proto__"` keys survive the round trip. |
| `migrateProject(input)` / `CURRENT_SCHEMA_VERSION` | function / const | Upgrades older documents step by step (schema 0 to 1 today); rejects documents newer than the engine supports. |
| `cloneProject(project)` | function | Deep copy. |
| `validateBuiltInComponent(name, value)` / `SCHEMATISED_COMPONENTS` | function / const | Checks one built-in component payload (`Transform`, `Primitive`, `Camera`, `Light`, `Model`, `Script`) and returns `ComponentIssue[]` (`field`, `code`, `message`, `remediation`); components without a schema and unknown fields are never inspected. `validateProject` runs it for every entity, so a bad payload surfaces as a `ValidationIssue` with a `remediation`. |
| `PRIMITIVE_KINDS`, `LIGHT_KINDS`, `CAMERA_TYPES` | consts | The values the schemas accept for `Primitive.kind`, `Light.kind` and `Camera.type`. |

## Example

```ts doc-check
import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  ProjectValidationError,
  assertValidProject,
  createProject,
  createScene,
  parseProject,
  serializeProject,
  stableId,
  validateProject,
} from "@kinetra/project-model";

const project = createProject({ name: "Demo", projectId: stableId("project", "demo") });
const scene = createScene("Main", stableId("scene", "main"));
scene.entities.push({
  id: stableId("entity", "player"),
  name: "Player",
  components: { Transform: { y: 1, x: 0 } },
});
project.scenes.push(scene);

// Ids from the same seed are identical on every machine and run.
assert.equal(stableId("entity", "player"), stableId("entity", "player"));
assert.deepEqual(validateProject(project), []);

// Serialization is canonical: keys come out sorted, so diffs stay small.
const text = serializeProject(project);
assert.ok(text.indexOf('"x"') < text.indexOf('"y"'));
assert.deepEqual(parseProject(text), parseProject(serializeProject(parseProject(text))));

// Older documents are migrated on parse.
const legacy = parseProject(
  JSON.stringify({ schemaVersion: 0, id: "legacy", name: "Old", scenes: [] }),
);
assert.equal(legacy.schemaVersion, CURRENT_SCHEMA_VERSION);
assert.equal(legacy.projectId, "legacy");

// Invalid documents report every issue with a path instead of failing on the first.
const broken = { ...project, scenes: [scene, scene] };
assert.ok(validateProject(broken).length > 0);
assert.throws(() => assertValidProject(broken), ProjectValidationError);
```

Built-in component payloads are checked as well (the runtime would otherwise silently fall back to defaults):

```ts doc-check
import assert from "node:assert/strict";
import {
  PRIMITIVE_KINDS,
  SCHEMATISED_COMPONENTS,
  createProject,
  createScene,
  validateBuiltInComponent,
  validateProject,
} from "@kinetra/project-model";

assert.ok(SCHEMATISED_COMPONENTS.includes("Transform"));
assert.deepEqual([...PRIMITIVE_KINDS], ["box", "sphere", "plane"]);

// One component on its own: a structured issue with a remediation.
const [issue] = validateBuiltInComponent("Primitive", { kind: "cylinder" });
assert.equal(issue?.code, "component.Primitive.kind.invalid");
assert.equal(issue?.field, "kind");
assert.match(issue?.remediation ?? "", /box, sphere, plane/);

// Unknown fields and components without a schema stay free-form.
assert.deepEqual(validateBuiltInComponent("Transform", { position: [0, 1, 2], tag: "free" }), []);
assert.deepEqual(validateBuiltInComponent("Collider", { shape: 12 }), []);

// validateProject reports the same problem at the field path.
const project = createProject({ name: "Demo" });
const scene = createScene("Main");
scene.entities.push({
  id: "entity_one",
  name: "One",
  components: { Transform: { position: [0, 1] } },
});
project.scenes.push(scene);
const [projectIssue] = validateProject(project);
assert.equal(projectIssue?.path, "scenes[0].entities[0].components.Transform.position");
assert.equal(projectIssue?.code, "component.Transform.position.invalid");
```

## Proof level

Covered by `test/project-model.test.ts`, `test/untrusted-input.test.ts`, `test/contracts.test.ts`, `test/canonical-order.test.ts`, `test/validation-scale.test.ts`, `test/migration-edge.test.ts` and `test/builtin-components.test.ts` (all in the package `test` script): schema validation of untrusted documents, locale-independent ordering, migration, serialization round trips, and built-in component payload rules (PR #172). See [`docs/STATUS.md`](../../docs/STATUS.md) for the project-wide proof table.

Not here: prefab/build/input/test data are defined by the packages that consume them; this package owns the document envelope, ids and migrations.
