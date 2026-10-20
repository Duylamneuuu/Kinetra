import assert from "node:assert/strict";
import test from "node:test";

import {
  instantiatePrefab,
  ScriptHost,
  ScriptRegistry,
  type GameScript,
  type GameScriptContext,
  type PrefabDefinition,
} from "../src/index.js";

interface LogEntry {
  level: string;
  category: string;
  data?: Record<string, unknown> | undefined;
}

function context(entityId: string, logs: LogEntry[] = []): GameScriptContext {
  return {
    entityId,
    sceneId: "scene",
    log: (level, category, data) => logs.push({ level, category, data }),
  };
}

test("emit() reaches only started scripts, in execution order, with payload and own context", async () => {
  const host = new ScriptHost();
  const seen: string[] = [];
  const make = (name: string): GameScript => ({
    onEvent(event, payload, ctx) {
      seen.push(`${name}:${event}:${JSON.stringify(payload)}:${ctx?.entityId}`);
    },
  });
  host.register({ id: "b", order: 2, context: context("eb"), script: make("b") });
  host.register({ id: "a", order: 1, context: context("ea"), script: make("a") });

  host.emit("early", 1); // nothing is started yet
  assert.deepEqual(seen, []);

  await host.startAll();
  host.emit("boom", { n: 2 });
  assert.deepEqual(seen, ['a:boom:{"n":2}:ea', 'b:boom:{"n":2}:eb']);

  await host.stopAll();
  host.emit("late", 3); // stopped scripts no longer receive events
  assert.equal(seen.length, 2);
});

test("a script whose onEvent throws is marked failed with phase onEvent while the others keep receiving events", async () => {
  const host = new ScriptHost();
  const logs: LogEntry[] = [];
  const received: string[] = [];
  host.register({
    id: "bad",
    order: 0,
    context: context("e-bad", logs),
    script: {
      onEvent() {
        throw new Error("event handler exploded");
      },
    },
  });
  host.register({
    id: "good",
    order: 1,
    context: context("e-good"),
    script: { onEvent: (event) => void received.push(event) },
  });
  await host.startAll();

  host.emit("first");
  host.emit("second");

  const bad = host.getExecutionState("bad")!;
  assert.equal(bad.lifecycleState, "error");
  assert.equal(bad.error, "event handler exploded");
  assert.deepEqual(received, ["first", "second"]);
  const logged = logs.filter((entry) => entry.category === "script.error");
  assert.equal(logged.length, 1, "a failed script is not asked again, so it logs once");
  assert.equal(logged[0]!.data?.phase, "onEvent");
  assert.equal(logged[0]!.data?.id, "bad");
});

test("update() rejects a non-finite or negative delta before touching any script", async () => {
  const host = new ScriptHost();
  let updates = 0;
  host.register({ id: "s", context: context("e"), script: { onUpdate: () => void updates++ } });
  await host.startAll();

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.001]) {
    assert.throws(() => host.update(bad), RangeError, `delta ${bad} should be rejected`);
  }
  assert.equal(updates, 0);

  host.update(0); // zero is a legal (paused) step
  assert.equal(updates, 1);
  assert.equal(host.getExecutionState("s")!.updateCount, 1);
});

test("ScriptRegistry resolves what was registered and lets a later registration replace it", () => {
  const registry = new ScriptRegistry();
  const first = () => ({}) as GameScript;
  const second = () => ({}) as GameScript;
  assert.equal(registry.has("hero"), false);
  assert.equal(registry.resolve("hero"), undefined);

  registry.register("hero", first);
  assert.equal(registry.has("hero"), true);
  assert.equal(registry.resolve("hero"), first);

  registry.register("hero", second);
  assert.equal(registry.resolve("hero"), second);
  assert.equal(registry.has("villain"), false);
});

test("validateScriptRestoreState maps every validator return shape to a structured result", () => {
  const host = new ScriptHost();
  const add = (id: string, validateRestoreState: unknown) =>
    host.register({
      id,
      context: context(`e-${id}`),
      script: { restoreState() {}, validateRestoreState } as unknown as GameScript,
    });
  add("true", () => true);
  add("false", () => false);
  add("object-ok", () => ({ valid: true }));
  add("object-bad", () => ({ valid: false, error: "hp must be positive" }));
  add("object-bad-silent", () => ({ valid: false }));
  add("undefined", () => undefined);
  add("null", () => null);
  add("throws", () => {
    throw new Error("validator blew up");
  });
  add("no-validator", undefined);

  assert.deepEqual(host.validateScriptRestoreState("true", {}), { valid: true });
  assert.deepEqual(host.validateScriptRestoreState("false", {}), {
    valid: false,
    error: 'Script "false" rejected state payload',
  });
  assert.deepEqual(host.validateScriptRestoreState("object-ok", {}), { valid: true });
  assert.deepEqual(host.validateScriptRestoreState("object-bad", {}), {
    valid: false,
    error: "hp must be positive",
  });
  assert.deepEqual(host.validateScriptRestoreState("object-bad-silent", {}), { valid: false });
  for (const id of ["undefined", "null"]) {
    const result = host.validateScriptRestoreState(id, {});
    assert.equal(result.valid, false);
    assert.match(result.error ?? "", /invalid validation response/);
  }
  assert.deepEqual(host.validateScriptRestoreState("throws", {}), { valid: false, error: "validator blew up" });
  assert.deepEqual(host.validateScriptRestoreState("no-validator", {}), { valid: true });
});

test("validateScriptRestoreState refuses unknown scripts and scripts that cannot restore", () => {
  const host = new ScriptHost();
  host.register({ id: "plain", context: context("e"), script: {} });

  assert.deepEqual(host.validateScriptRestoreState("ghost", {}), {
    valid: false,
    error: 'Script "ghost" is not registered',
  });
  assert.deepEqual(host.validateScriptRestoreState("plain", {}), {
    valid: false,
    error: 'Script "plain" does not support state restoration',
  });
});

test("restore capability queries and restore calls agree for unknown, plain, legacy and transactional scripts", async () => {
  const host = new ScriptHost();
  const applied: unknown[] = [];
  host.register({ id: "plain", context: context("e1"), script: {} });
  host.register({
    id: "legacy",
    context: context("e2"),
    script: { restoreState: (state) => void applied.push(["legacy", state]) },
  });
  host.register({
    id: "tx",
    context: context("e3"),
    script: {
      prepareRestoreState: (state) => ({
        commit: () => void applied.push(["tx", state]),
        rollback: () => undefined,
      }),
    },
  });

  assert.equal(host.hasScript("ghost"), false);
  assert.equal(host.hasScript("plain"), true);
  assert.deepEqual(
    ["ghost", "plain", "legacy", "tx"].map((id) => host.canRestoreScriptState(id)),
    [false, false, true, true],
  );
  assert.deepEqual(
    ["ghost", "plain", "legacy", "tx"].map((id) => host.canPrepareTransactionalRestore(id)),
    [false, false, false, true],
  );

  assert.equal(await host.restoreScriptState("ghost", {}), false);
  assert.equal(await host.restoreScriptState("plain", {}), false);
  assert.equal(await host.restoreScriptState("legacy", { a: 1 }), true);
  assert.equal(await host.restoreScriptState("tx", { b: 2 }), true);
  assert.deepEqual(applied, [
    ["legacy", { a: 1 }],
    ["tx", { b: 2 }],
  ]);

  await assert.rejects(() => host.prepareScriptRestore("ghost", {}), /"ghost" is not registered/);
  await assert.rejects(() => host.prepareScriptRestore("plain", {}), /does not support transactional/);
});

test("execution queries tolerate a throwing getState and report every script", async () => {
  const host = new ScriptHost();
  host.register({
    id: "fragile",
    scriptId: "script.fragile",
    context: context("e1"),
    script: {
      getState() {
        throw new Error("state unavailable");
      },
    },
  });
  host.register({ id: "stateful", context: context("e2"), script: { getState: () => ({ hp: 3 }) } });

  assert.equal(host.isCreated("fragile"), false);
  assert.equal(host.isStopApplicable("fragile"), false);
  assert.equal(host.isDestroyApplicable("fragile"), false);
  assert.equal(host.isCreated("ghost"), false);
  assert.equal(host.isStarted("ghost"), false);
  assert.equal(host.isStopApplicable("ghost"), false);
  assert.equal(host.isDestroyApplicable("ghost"), false);
  assert.equal(host.getExecutionState("ghost"), undefined);

  await host.startAll();
  assert.equal(host.isCreated("fragile"), true);
  assert.equal(host.isStarted("fragile"), true);
  assert.equal(host.isStopApplicable("fragile"), true);
  assert.equal(host.isDestroyApplicable("fragile"), true);

  const states = host.getAllExecutionStates();
  assert.deepEqual(
    states.map((state) => state.id),
    ["fragile", "stateful"],
  );
  assert.equal(states[0]!.scriptId, "script.fragile");
  assert.equal("state" in states[0]!, false, "a throwing getState yields no state instead of failing the query");
  assert.deepEqual(states[1]!.state, { hp: 3 });
  assert.equal("scriptId" in states[1]!, false);

  await host.destroyAll();
  assert.deepEqual(host.getAllExecutionStates(), []);
  assert.equal(host.hasScript("fragile"), false);
});

const prefab: PrefabDefinition = {
  id: "crate",
  name: "Crate",
  entities: [
    { localId: "root", name: "Root", components: { Transform: { position: [0, 0, 0] }, Tag: { label: "a" } } },
    { localId: "lid", name: "Lid", parentLocalId: "root", components: { Mesh: "lid" } },
  ],
};

test("prefab ids that would collide or be empty are rejected", () => {
  assert.throws(() => instantiatePrefab({ prefab: { ...prefab, id: "" }, instanceId: "i" }), /Prefab id must not be empty/);
  assert.throws(() => instantiatePrefab({ prefab: { ...prefab, id: "a:b" }, instanceId: "i" }), /must not contain ":"/);
  assert.throws(() => instantiatePrefab({ prefab, instanceId: "" }), /Prefab instance id must not be empty/);
  assert.throws(() => instantiatePrefab({ prefab, instanceId: "x:y" }), /must not contain ":"/);
  assert.throws(
    () =>
      instantiatePrefab({
        prefab: { ...prefab, entities: [...prefab.entities, { localId: "root", name: "Dup", components: {} }] },
        instanceId: "i",
      }),
    /local IDs must be unique/,
  );
});

test("prefab instances are deterministic, distinct per instance id, and never alias the template", () => {
  const one = instantiatePrefab({ prefab, instanceId: "one" });
  const again = instantiatePrefab({ prefab, instanceId: "one" });
  const two = instantiatePrefab({ prefab, instanceId: "two" });

  assert.deepEqual(one, again);
  assert.equal(new Set([...one, ...two].map((entity) => entity.id)).size, 4);
  assert.equal(one[1]!.parentId, one[0]!.id);
  assert.equal("parentId" in one[0]!, false);

  (one[0]!.components.Tag as { label: string }).label = "mutated";
  (one[0]!.components.Transform as { position: number[] }).position.push(99);
  assert.deepEqual(prefab.entities[0]!.components.Tag, { label: "a" }, "the template must not be mutated");
  assert.deepEqual(prefab.entities[0]!.components.Transform, { position: [0, 0, 0] });
  assert.deepEqual(instantiatePrefab({ prefab, instanceId: "one" }), again);
});

test("prefab overrides merge into existing data, add new components and reject bad targets", () => {
  const out = instantiatePrefab({
    prefab,
    instanceId: "i",
    overrides: [
      { localId: "root", component: "Tag", patch: { extra: 1 } },
      { localId: "root", component: "Health", patch: { hp: 5 } },
      { localId: "root", component: "Tag", patch: { label: "b" } },
    ],
  });
  assert.deepEqual(out[0]!.components.Tag, { label: "b", extra: 1 });
  assert.deepEqual(out[0]!.components.Health, { hp: 5 });
  assert.deepEqual(prefab.entities[0]!.components.Tag, { label: "a" });

  assert.throws(
    () => instantiatePrefab({ prefab, instanceId: "i", overrides: [{ localId: "ghost", component: "Tag", patch: {} }] }),
    /unknown prefab entity "ghost"/,
  );
  assert.throws(
    () => instantiatePrefab({ prefab, instanceId: "i", overrides: [{ localId: "lid", component: "Mesh", patch: { a: 1 } }] }),
    /not object data and cannot be patched/,
  );
  assert.throws(
    () =>
      instantiatePrefab({
        prefab,
        instanceId: "i",
        overrides: [{ localId: "root", component: "prototype", patch: {} }],
      }),
    /reserved/,
  );
});

test("a script shapeCast goes through context.physics and returns the hit", async () => {
  const seen: string[] = [];
  const script: GameScript = {
    onUpdate(context) {
      const hit = context.physics?.shapeCast({
        shape: { type: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
        origin: { x: 0, y: 1, z: 0 },
        direction: { x: 0, y: -1, z: 0 },
      });
      const ray = context.physics?.raycast({
        origin: { x: 0, y: 1, z: 0 },
        direction: { x: 0, y: -1, z: 0 },
      });
      seen.push(`${hit?.entityId ?? "miss"}:${ray?.entityId ?? "miss"}:${hit?.point.y}`);
    },
  };
  const host = new ScriptHost();
  host.register({
    id: "caster",
    context: {
      entityId: "caster",
      sceneId: "scene",
      physics: {
        raycast: () => ({
          entityId: "floor",
          point: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          distance: 1,
          startedInside: false,
        }),
        shapeCast: () => ({
          entityId: "floor",
          point: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          distance: 0.5,
          startedInside: false,
        }),
      },
    },
    script,
  });
  await host.startAll();
  host.update(1 / 60);
  assert.deepEqual(seen, ["floor:floor:0"]);
});
