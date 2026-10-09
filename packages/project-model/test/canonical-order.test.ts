import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  createScene,
  normalizeProject,
  parseProject,
  serializeProject,
  type ProjectDocument,
} from "../src/index.js";

/** Rebuilds a plain object with its keys in the given order (own data properties only). */
function reorder<T extends object>(value: T, keys: readonly string[]): T {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) Object.defineProperty(out, key, { value: source[key], enumerable: true, writable: true, configurable: true });
  }
  return out as T;
}

function sample(): ProjectDocument {
  const project = createProject({ name: "Canonical", projectId: "project_canonical" });
  const scene = createScene("Main", "scene_main");
  scene.entities.push(
    { id: "e_root", name: "Root", components: { Transform: { position: [0, 1, 2] } } },
    { id: "e_child", name: "Child", parentId: "e_root", components: { Tag: { value: "x" } } },
  );
  project.scenes.push(scene);
  project.metadata = { author: "Văn" };
  return project;
}

test("serialization does not depend on the property order of project, scene or entity objects", () => {
  const expected = serializeProject(sample());

  const shuffled = sample();
  shuffled.scenes = shuffled.scenes.map((scene) => {
    scene.entities = scene.entities.map((entity) =>
      reorder(entity, ["components", "parentId", "name", "id"]),
    );
    return reorder(scene, ["entities", "name", "id"]);
  });
  const reordered = reorder(shuffled, ["metadata", "scenes", "name", "projectId", "schemaVersion"]);

  assert.equal(serializeProject(reordered), expected);
});

test("a reparent that appends parentId last serializes like a document authored with parentId in place", () => {
  const authored = sample();

  const edited = sample();
  const child = edited.scenes[0]!.entities[1]!;
  delete child.parentId;
  child.parentId = "e_root"; // re-added after `components`, as an in-place reparent does

  assert.deepEqual(Object.keys(child), ["id", "name", "components", "parentId"]);
  assert.equal(serializeProject(edited), serializeProject(authored));
});

test("normalizeProject emits schema-ordered keys and keeps unknown keys, sorted, after them", () => {
  const project = sample() as ProjectDocument & Record<string, unknown>;
  project["zeta"] = 1;
  project["alpha"] = 2;
  const entity = project.scenes[0]!.entities[0]! as unknown as Record<string, unknown>;
  entity["note"] = "kept";

  const normalized = normalizeProject(project) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(normalized), [
    "schemaVersion",
    "projectId",
    "name",
    "scenes",
    "metadata",
    "alpha",
    "zeta",
  ]);
  const scene = (normalized["scenes"] as ProjectDocument["scenes"])[0]!;
  assert.deepEqual(Object.keys(scene), ["id", "name", "entities"]);
  const sortedEntities = scene.entities;
  assert.deepEqual(Object.keys(sortedEntities[0]!), ["id", "name", "parentId", "components"]);
  assert.deepEqual(Object.keys(sortedEntities[1]!), ["id", "name", "components", "note"]);
});

test("canonical key order is a fixed point across parse and leaves the input untouched", () => {
  const input = sample();
  const before = JSON.stringify(input);
  const text = serializeProject(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(serializeProject(parseProject(text)), text);
  assert.equal(text.indexOf('"schemaVersion"') < text.indexOf('"projectId"'), true);
  assert.equal(text.indexOf('"parentId"') < text.indexOf('"components"', text.indexOf('"parentId"') - 80), true);
});

test("an extra unknown key named __proto__ survives key canonicalization as an own property", () => {
  const text = '{"schemaVersion":1,"projectId":"p","name":"n","scenes":[],"__proto__":{"x":1}}';
  const parsed = parseProject(text);
  const normalized = normalizeProject(parsed);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.deepEqual(Object.keys(normalized), ["schemaVersion", "projectId", "name", "scenes", "__proto__"]);
  assert.equal(({} as { x?: number }).x, undefined);
  assert.equal(serializeProject(parseProject(serializeProject(parsed))), serializeProject(parsed));
});
