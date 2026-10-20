import assert from "node:assert/strict";
import test from "node:test";

import {
  GameModuleError,
  GameModuleRegistry,
  ScriptRegistry,
  type GameModule,
} from "../src/index.js";

function moduleFor(id: string): GameModule {
  return {
    id,
    registerScripts(registry) {
      registry.register(`${id}.pulse`, () => ({
        getState: () => ({ id }),
      }));
    },
  };
}

test("the default module loads when no id is passed, and an unknown id does not", async () => {
  const registry = new GameModuleRegistry("arena");
  registry.register("arena", () => moduleFor("arena"));
  assert.equal((await registry.load()).id, "arena");
  assert.equal((await registry.load(undefined)).id, "arena");
  await assert.rejects(() => registry.load("marker"), (error: unknown) => {
    assert.ok(error instanceof GameModuleError);
    assert.equal(error.code, "game.unknown");
    assert.match(error.message, /\[game\.unknown\]/);
    assert.match(error.remediation, /arena/);
    return true;
  });
});

test("invalid ids are rejected before a loader runs", async () => {
  const registry = new GameModuleRegistry("arena");
  let loads = 0;
  registry.register("arena", () => {
    loads += 1;
    return moduleFor("arena");
  });
  for (const id of ["", "Arena", "marker_game", "-marker", "a".repeat(65), "__proto__"]) {
    await assert.rejects(() => registry.load(id), (error: unknown) => {
      assert.ok(error instanceof GameModuleError);
      assert.equal(error.code, "game.invalidId");
      return true;
    });
  }
  assert.equal(loads, 0);
  registry.register("constructor", () => moduleFor("constructor"));
  assert.equal((await registry.load("constructor")).id, "constructor");
});

test("a successful load is cached and a failed load is tried again", async () => {
  const registry = new GameModuleRegistry("arena");
  let loads = 0;
  registry.register("arena", () => {
    loads += 1;
    return moduleFor("arena");
  });
  const first = await registry.load("arena");
  const second = await registry.load("arena");
  assert.equal(first, second);
  assert.equal(loads, 1);

  let attempts = 0;
  registry.register("flaky", () => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk");
    return moduleFor("flaky");
  });
  await assert.rejects(() => registry.load("flaky"), (error: unknown) => {
    assert.ok(error instanceof GameModuleError);
    assert.equal(error.code, "game.loadFailed");
    assert.match(error.message, /disk/);
    return true;
  });
  assert.equal((await registry.load("flaky")).id, "flaky");
  assert.equal(attempts, 2);
});

test("a loader that returns the wrong id is game.invalidModule and is not cached", async () => {
  const registry = new GameModuleRegistry();
  let attempts = 0;
  registry.register("marker", () => {
    attempts += 1;
    return attempts === 1 ? moduleFor("other") : moduleFor("marker");
  });
  await assert.rejects(() => registry.load("marker"), (error: unknown) => {
    assert.ok(error instanceof GameModuleError);
    assert.equal(error.code, "game.invalidModule");
    return true;
  });
  assert.equal((await registry.load("marker")).id, "marker");
  await assert.rejects(() => registry.load("nope"), (error: unknown) => {
    assert.ok(error instanceof GameModuleError);
    assert.equal(error.code, "game.unknown");
    return true;
  });
});

test("registerScripts on one registry does not leak into the next", () => {
  const marker = moduleFor("marker");
  const arena = moduleFor("arena");
  const first = new ScriptRegistry();
  const second = new ScriptRegistry();
  marker.registerScripts(first, { sceneId: "scene" });
  arena.registerScripts(second, { sceneId: "scene" });
  assert.equal(first.has("marker.pulse"), true);
  assert.equal(first.has("arena.pulse"), false);
  assert.equal(second.has("arena.pulse"), true);
  assert.equal(second.has("marker.pulse"), false);
});
