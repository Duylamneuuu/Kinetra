import assert from "node:assert/strict";
import test from "node:test";

import { resolveStartScene } from "../src/start-scene.js";

const project = {
  scenes: [
    { id: "scene.main", name: "Main" },
    { id: "scene.bonus", name: "Bonus" },
  ],
};

test("resolveStartScene returns the scene that matches the id", () => {
  assert.equal(resolveStartScene(project, "scene.bonus"), project.scenes[1]);
});

test("resolveStartScene throws the documented error for an unknown scene", () => {
  assert.throws(
    () => resolveStartScene(project, "scene.missing"),
    /Scene "scene\.missing" does not exist/,
  );
});

test("resolveStartScene is exact: no prefix or case-insensitive matches", () => {
  assert.throws(() => resolveStartScene(project, "scene"), /does not exist/);
  assert.throws(() => resolveStartScene(project, "SCENE.MAIN"), /does not exist/);
});

test("resolveStartScene throws on a project without scenes", () => {
  assert.throws(() => resolveStartScene({ scenes: [] }, "scene.main"), /does not exist/);
});
