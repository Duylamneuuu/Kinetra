# @kinetra/core

Runtime lifecycle and engine-level contracts that are independent of editor/provider integrations.

Core owns three things: the **script runtime** (`ScriptHost`, `ScriptRegistry`, the `GameScript` contract and the services a script sees through `GameScriptContext`), the **scene lifecycle** state machine, and **prefab instantiation**. It does not import Three.js, Rapier or Recast: renderer, physics, navigation and audio are injected as the small service interfaces in `src/scripts.ts`.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `ScriptRegistry` | class | `register(scriptId, factory)` / `resolve` / `has`: maps a script id to a `GameScriptFactory`. |
| `ScriptHost` | class | Runs scripts in deterministic order (`order`, then id by code unit, never by locale). `register`, `startAll`, `update(dt)`, `emit(event, payload)`, `stopAll`, `destroyAll`, plus state queries (`getExecutionState`, `getAllExecutionStates`). |
| `GameScript` | interface | Optional hooks `onCreate`, `onStart`, `onUpdate`, `onEvent`, `onStop`, `onDestroy`, and save/restore hooks `getState`, `validateRestoreState`, `prepareRestoreState` (transactional commit/rollback), `restoreState`. |
| `GameScriptContext` | interface | What a script may touch: `input`, `transform`, `scene`, `navigation`, `audio`, `animation`, `emit`, `log`. Every service is optional. |
| `PlayerControllerScript` | class | Small reference script (move/jump counters) with a full transactional restore implementation. |
| `SceneLifecycle` | class | `unloaded -> loading -> loaded -> active <-> paused -> unloading`. Exactly one adapter call in flight; overlapping or illegal transitions throw; a failed adapter call restores the previous state. |
| `instantiatePrefab({ prefab, instanceId, overrides? })` | function | Expands a `PrefabDefinition` into `EntityDefinition[]` with deterministic ids (`prefabId:instanceId:localId`), applying `PrefabOverride` patches. Rejects empty/`:`-containing ids, duplicate local ids, missing parents and parent cycles. |

## Behaviour worth knowing

- A script that throws in any hook goes to lifecycle state `error` (with `error` text and a `script.error` log), is skipped afterwards, and does not stop other scripts.
- `stopAll` runs `onStop` only for scripts that started, in reverse order; `destroyAll` stops first, then runs `onDestroy` for scripts that were created, and clears the host.
- `update(dt)` throws `RangeError` for a negative or non-finite `dt`; `register` throws on a duplicate id or a non-finite `order`.

## Example

```ts doc-check
import assert from "node:assert/strict";
import {
  ScriptHost,
  SceneLifecycle,
  instantiatePrefab,
  type GameScript,
  type GameScriptContext,
} from "@kinetra/core";

// --- Scripts: deterministic order, isolated failures -------------------------
const calls: string[] = [];
const context = (entityId: string): GameScriptContext => ({
  entityId,
  sceneId: "scene_main",
  log: (_level, category) => calls.push(`log:${category}`),
});
const counter: GameScript = {
  onStart: () => void calls.push("counter:start"),
  onUpdate: (_ctx, dt) => void calls.push(`counter:update:${dt}`),
  onStop: () => void calls.push("counter:stop"),
};
const broken: GameScript = {
  onUpdate: () => {
    throw new Error("boom");
  },
};

const host = new ScriptHost();
host.register({ id: "b-broken", order: 1, context: context("e2"), script: broken });
host.register({ id: "a-counter", order: 0, context: context("e1"), script: counter });
await host.startAll();
host.update(0.5);
assert.equal(host.getExecutionState("b-broken")?.lifecycleState, "error");
assert.equal(host.getExecutionState("a-counter")?.updateCount, 1);
await host.destroyAll();
assert.deepEqual(calls.filter((entry) => entry.startsWith("counter")), [
  "counter:start",
  "counter:update:0.5",
  "counter:stop",
]);

// --- Scene lifecycle: one transition at a time ------------------------------
const scene = new SceneLifecycle("scene_main", {
  load: async () => {},
  activate: async () => {},
  unload: async () => {},
});
await scene.load();
await scene.activate();
assert.equal(scene.state, "active");
await assert.rejects(() => scene.activate(), /cannot transition/);
await scene.unload();
assert.equal(scene.state, "unloaded");

// --- Prefabs: same inputs, same ids -----------------------------------------
const prefab = {
  id: "crate",
  name: "Crate",
  entities: [
    { localId: "root", name: "Crate", components: { Transform: { x: 0 } } },
    { localId: "lid", name: "Lid", parentLocalId: "root", components: {} },
  ],
};
const first = instantiatePrefab({
  prefab,
  instanceId: "one",
  overrides: [{ localId: "root", component: "Transform", patch: { x: 4 } }],
});
const again = instantiatePrefab({ prefab, instanceId: "one" });
assert.equal(first[0]!.id, again[0]!.id);
assert.equal(first[1]!.parentId, first[0]!.id);
assert.deepEqual(first[0]!.components.Transform, { x: 4 });
assert.throws(() => instantiatePrefab({ prefab, instanceId: "bad:id" }), /must not contain/);
```

## Proof level

Unit and property tests live in `packages/core/test` and are listed in the package `test` script; the Arena reference game (`examples/reference-game`) and the Electron player exercise `ScriptHost` end to end (see [`docs/STATUS.md`](../../docs/STATUS.md)).
