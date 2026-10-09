import assert from "node:assert/strict";
import test from "node:test";

import { instantiatePrefab, type PrefabDefinition } from "../src/index.js";

const prefab: PrefabDefinition = {
  id: "crate",
  name: "Crate",
  entities: [{ localId: "root", name: "Crate", components: { transform: { x: 1 } } }],
};

test("an override named __proto__ is rejected instead of re-prototyping the component map", () => {
  assert.throws(
    () =>
      instantiatePrefab({
        prefab,
        instanceId: "a",
        overrides: [{ localId: "root", component: "__proto__", patch: { polluted: true } }],
      }),
    /reserved/,
  );
});

test("an override named constructor is rejected like the command bus rejects it", () => {
  assert.throws(
    () =>
      instantiatePrefab({
        prefab,
        instanceId: "a",
        overrides: [{ localId: "root", component: "constructor", patch: { a: 1 } }],
      }),
    /reserved/,
  );
});

test("inherited Object.prototype names do not count as existing component data", () => {
  const [entity] = instantiatePrefab({
    prefab,
    instanceId: "a",
    overrides: [{ localId: "root", component: "toString", patch: { label: "x" } }],
  });
  assert.deepEqual(Object.keys(entity!.components).sort(), ["toString", "transform"]);
  assert.deepEqual(entity!.components.toString, { label: "x" });
  assert.equal(Object.getPrototypeOf(entity!.components), Object.prototype);
});
