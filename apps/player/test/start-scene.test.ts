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

import { resolveSceneThenTearDown } from "../src/start-scene.js";

test("resolveSceneThenTearDown rejects an unknown scene without running the teardown (#479)", async () => {
  let stopped = 0;
  let assetsReplaced = 0;
  await assert.rejects(
    resolveSceneThenTearDown(project, "khong-ton-tai", async () => {
      stopped += 1;
      assetsReplaced += 1;
    }),
    /Scene "khong-ton-tai" does not exist/,
  );
  assert.equal(stopped, 0, "the running game must not be stopped");
  assert.equal(assetsReplaced, 0, "the current assets must not be overwritten");
});

test("resolveSceneThenTearDown tears down exactly once, after resolving, for a known scene", async () => {
  const order: string[] = [];
  const scene = await resolveSceneThenTearDown(project, "scene.bonus", async () => {
    order.push("teardown");
  });
  assert.equal(scene, project.scenes[1]);
  assert.deepEqual(order, ["teardown"]);
});

test("resolveSceneThenTearDown propagates a teardown failure", async () => {
  await assert.rejects(
    resolveSceneThenTearDown(project, "scene.main", async () => {
      throw new Error("stop failed");
    }),
    /stop failed/,
  );
});
