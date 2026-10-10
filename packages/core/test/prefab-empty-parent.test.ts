import assert from "node:assert/strict";
import test from "node:test";

import { instantiatePrefab, type PrefabDefinition } from "../src/index.js";

const withParent = (parentLocalId: unknown): PrefabDefinition => ({
  id: "crate",
  name: "Crate",
  entities: [
    { localId: "root", name: "Root", components: {} },
    { localId: "lid", name: "Lid", parentLocalId, components: {} } as PrefabDefinition["entities"][number],
  ],
});

test("an empty parentLocalId is rejected instead of silently detaching the entity", () => {
  assert.throws(
    () => instantiatePrefab({ prefab: withParent(""), instanceId: "a" }),
    /Prefab parent "" does not exist/,
  );
});

test("an omitted or null parentLocalId still makes a root entity", () => {
  for (const parent of [undefined, null]) {
    const [root, lid] = instantiatePrefab({ prefab: withParent(parent), instanceId: "a" });
    assert.equal(root!.parentId, undefined);
    assert.equal(lid!.parentId, undefined);
  }
});

test("a real parentLocalId still links the instantiated entities", () => {
  const [root, lid] = instantiatePrefab({ prefab: withParent("root"), instanceId: "a" });
  assert.equal(lid!.parentId, root!.id);
});
