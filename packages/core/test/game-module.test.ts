import assert from "node:assert/strict";
import test from "node:test";

import { createProject } from "@kinetra/project-model";

import {
  GameModuleError,
  GameModuleRegistry,
  ScriptRegistry,
  type GameModule,
} from "../src/index.js";

function moduleFor(id: string, scriptIds: string[] = [`${id}Script`]): GameModule {
  return {
    id,
    registerScripts(registry) {
      for (const scriptId of scriptIds) {
        registry.register(scriptId, () => ({}));
      }
    },
  };
}

const context = { project: createProject({ name: "Demo" }), sceneId: "scene_main" };

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GameModuleError, `expected GameModuleError, got ${String(error)}`);
    assert.ok(error.remediation.length > 0, "every error carries a remediation");
    return error.code;
  }
  return "no-error";
}

test("registry resolves registered modules and lists ids in code-point order", async () => {
  const registry = new GameModuleRegistry({ defaultId: "arena" });
  registry.register("orb-run", () => moduleFor("orb-run"));
  registry.register("arena", () => moduleFor("arena"));
  registry.register("Zed".toLowerCase(), () => moduleFor("zed"));

  assert.deepEqual(registry.ids(), ["arena", "orb-run", "zed"]);
  assert.equal(registry.has("orb-run"), true);
  assert.equal(registry.has("nope"), false);
  assert.equal(registry.defaultId, "arena");
  assert.equal((await registry.load("orb-run")).id, "orb-run");
  assert.equal((await registry.load()).id, "arena", "undefined selects the default game");
});

test("unknown ids fail with game.unknown and list what is available", async () => {
  const registry = new GameModuleRegistry({ defaultId: "arena" });
  registry.register("arena", () => moduleFor("arena"));

  assert.equal(await code(registry.load("missing")), "game.unknown");
  await assert.rejects(registry.load("missing"), (error: GameModuleError) =>
    error.remediation.includes('"arena"') && error.message.includes('"missing"'),
  );
});

test("inherited object properties are never treated as registered games", async () => {
  const registry = new GameModuleRegistry({ defaultId: "arena" });
  registry.register("arena", () => moduleFor("arena"));

  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const result = await code(registry.load(id));
    assert.ok(
      result === "game.invalidId" || result === "game.unknown",
      `"${id}" must be rejected, got ${result}`,
    );
    assert.equal(registry.has(id), false);
  }
});

test("invalid ids are rejected before any loader runs", async () => {
  let calls = 0;
  const registry = new GameModuleRegistry();
  assert.throws(() => registry.register("Bad Id", () => (calls++, moduleFor("x"))), GameModuleError);
  assert.throws(() => registry.register("", () => moduleFor("x")), GameModuleError);
  assert.throws(() => registry.register("a".repeat(65), () => moduleFor("x")), GameModuleError);
  assert.equal(await code(registry.load("../etc/passwd")), "game.invalidId");
  assert.equal(await code(registry.load("x".repeat(200))), "game.invalidId");
  assert.equal(await code(registry.load(123 as unknown as string)), "game.invalidId");
  assert.equal(calls, 0);
});

test("with no default and no id, load fails instead of guessing", async () => {
  const registry = new GameModuleRegistry();
  registry.register("arena", () => moduleFor("arena"));
  assert.equal(await code(registry.load()), "game.unknown");
});

test("loaders are lazy and the loaded module is cached", async () => {
  let loads = 0;
  const registry = new GameModuleRegistry();
  registry.register("lazy", async () => {
    loads += 1;
    return moduleFor("lazy");
  });
  assert.equal(loads, 0, "register does not load");
  const [first, second] = await Promise.all([registry.load("lazy"), registry.load("lazy")]);
  assert.equal(first.id, "lazy");
  assert.equal(second.id, "lazy");
  const third = await registry.load("lazy");
  assert.equal(third, await registry.load("lazy"));
  assert.ok(loads >= 1 && loads <= 2, `concurrent first loads may race but later loads are cached (loads=${loads})`);
  const settled = loads;
  await registry.load("lazy");
  assert.equal(loads, settled);
});

test("re-registering an id drops the cached module", async () => {
  const registry = new GameModuleRegistry();
  registry.register("g", () => moduleFor("g", ["One"]));
  const first = await registry.createScriptRegistry("g", context);
  assert.equal(first.registry.has("One"), true);
  registry.register("g", () => moduleFor("g", ["Two"]));
  const second = await registry.createScriptRegistry("g", context);
  assert.equal(second.registry.has("Two"), true);
  assert.equal(second.registry.has("One"), false);
});

test("loader failures and malformed modules are structured errors", async () => {
  const registry = new GameModuleRegistry();
  registry.register("boom", () => {
    throw new Error("chunk 404");
  });
  registry.register("async-boom", async () => {
    throw new Error("network down");
  });
  registry.register("mismatch", () => moduleFor("other"));
  registry.register("no-register", () => ({ id: "no-register" }) as unknown as GameModule);
  registry.register("nullish", () => null as unknown as GameModule);

  assert.equal(await code(registry.load("boom")), "game.loadFailed");
  assert.equal(await code(registry.load("async-boom")), "game.loadFailed");
  await assert.rejects(registry.load("boom"), /chunk 404/);
  assert.equal(await code(registry.load("mismatch")), "game.invalidModule");
  assert.equal(await code(registry.load("no-register")), "game.invalidModule");
  assert.equal(await code(registry.load("nullish")), "game.invalidModule");
});

test("a failed load is not cached, so a later retry can succeed", async () => {
  let attempts = 0;
  const registry = new GameModuleRegistry();
  registry.register("flaky", () => {
    attempts += 1;
    if (attempts === 1) throw new Error("first attempt fails");
    return moduleFor("flaky");
  });
  assert.equal(await code(registry.load("flaky")), "game.loadFailed");
  assert.equal((await registry.load("flaky")).id, "flaky");
});

test("createScriptRegistry gives every start its own registry", async () => {
  const registry = new GameModuleRegistry();
  registry.register("g", () => moduleFor("g", ["A", "B"]));
  const one = await registry.createScriptRegistry("g", context);
  const two = await registry.createScriptRegistry("g", context);
  assert.notEqual(one.registry, two.registry);
  assert.ok(one.registry instanceof ScriptRegistry);
  one.registry.register("OnlyInOne", () => ({}));
  assert.equal(two.registry.has("OnlyInOne"), false);
  assert.equal(one.registry.has("A") && one.registry.has("B"), true);
});

test("registerScripts receives the project and scene, and its errors become game.registerFailed", async () => {
  const seen: Array<{ projectId: string; sceneId: string }> = [];
  const registry = new GameModuleRegistry();
  registry.register("picky", () => ({
    id: "picky",
    registerScripts(_registry, ctx) {
      seen.push({ projectId: ctx.project.projectId, sceneId: ctx.sceneId });
      throw new Error("needs exactly one manager entity, found 0");
    },
  }));

  await assert.rejects(registry.createScriptRegistry("picky", context), (error: GameModuleError) => {
    assert.equal(error.code, "game.registerFailed");
    assert.match(error.message, /scene_main/);
    assert.match(error.message, /exactly one manager/);
    return true;
  });
  assert.deepEqual(seen, [{ projectId: context.project.projectId, sceneId: "scene_main" }]);
});

test("readGameState is optional and passes through to callers", async () => {
  const registry = new GameModuleRegistry();
  registry.register("with-state", () => ({
    id: "with-state",
    registerScripts() {},
    readGameState: (entities) => {
      const manager = entities.find((entity) => entity.gameplay?.scriptId === "Manager");
      return manager?.gameplay?.state ? { ...manager.gameplay.state } : undefined;
    },
  }));
  registry.register("without-state", () => moduleFor("without-state"));

  const withState = await registry.load("with-state");
  assert.deepEqual(
    withState.readGameState?.([
      { entityId: "e1", name: "Manager", gameplay: { scriptId: "Manager", state: { status: "won" } } },
    ]),
    { status: "won" },
  );
  assert.equal(withState.readGameState?.([]), undefined);
  assert.equal((await registry.load("without-state")).readGameState, undefined);
});
