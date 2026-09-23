import assert from "node:assert/strict";
import test from "node:test";
import { ScriptHost, SceneLifecycle, instantiatePrefab, ScriptRegistry, PlayerControllerScript, type PreparedScriptRestore } from "../src/index.js";

test("script lifecycle is deterministic and tears down in reverse order",async()=>{
  const log:string[]=[];
  const host=new ScriptHost();
  for(const [id,order] of [["b",2],["a",1]] as const){
    host.register({
      id,order,context:{entityId:id,sceneId:"main"},
      script:{
        onCreate:()=>{log.push(`create:${id}`)},
        onStart:()=>{log.push(`start:${id}`)},
        onUpdate:()=>{log.push(`update:${id}`)},
        onStop:()=>{log.push(`stop:${id}`)},
        onDestroy:()=>{log.push(`destroy:${id}`)},
      }
    });
  }
  await host.startAll();
  host.update(1/60);
  await host.destroyAll();
  assert.deepEqual(log,[
    "create:a","start:a","create:b","start:b",
    "update:a","update:b",
    "stop:b","stop:a","destroy:b","destroy:a"
  ]);
});

test("scene lifecycle enforces legal transitions",async()=>{
  const log:string[]=[];
  const scene=new SceneLifecycle("main",{
    async load(){log.push("load")},
    async activate(){log.push("activate")},
    async pause(){log.push("pause")},
    async resume(){log.push("resume")},
    async unload(){log.push("unload")},
  });
  await scene.load();
  await scene.activate();
  await scene.pause();
  await scene.resume();
  await scene.unload();
  assert.equal(scene.state,"unloaded");
  assert.deepEqual(log,["load","activate","pause","resume","unload"]);
  await assert.rejects(()=>scene.activate(),/cannot transition/);
});

test("prefab instantiation creates stable hierarchy and explicit overrides",()=>{
  const prefab={
    id:"prefab_enemy",name:"Enemy",
    entities:[
      {localId:"root",name:"Enemy",components:{Health:{value:100}}},
      {localId:"mesh",name:"Mesh",parentLocalId:"root",components:{Transform:{position:[0,1,0]}}},
    ],
  };
  const first=instantiatePrefab({
    prefab,instanceId:"enemy-1",
    overrides:[{localId:"root",component:"Health",patch:{value:250}}],
  });
  const second=instantiatePrefab({prefab,instanceId:"enemy-1"});
  assert.equal(first[1]?.parentId,first[0]?.id);
  assert.equal(first[0]?.id,second[0]?.id);
  assert.deepEqual(first[0]?.components.Health,{value:250});

  assert.throws(
    ()=>instantiatePrefab({
      prefab:{
        id:"prefab_dup",
        name:"Dup",
        entities:[
          {localId:"root",name:"A",components:{}},
          {localId:"root",name:"B",components:{}},
        ],
      },
      instanceId:"dup-1",
    }),
    /Prefab local IDs must be unique\. Duplicates: root\./,
  );
  assert.throws(
    ()=>instantiatePrefab({
      prefab:{
        ...prefab,
        entities:[
          ...prefab.entities,
          {localId:"orphan",name:"Orphan",parentLocalId:"missing-parent",components:{}},
        ],
      },
      instanceId:"enemy-2",
    }),
    /Prefab parent "missing-parent" does not exist\. Available local ids: mesh, orphan, root\./,
  );
  assert.throws(
    ()=>instantiatePrefab({
      prefab,
      instanceId:"enemy-3",
      overrides:[{localId:"missing-local",component:"Health",patch:{value:1}}],
    }),
    /Override targets unknown prefab entity "missing-local"\. Available local ids: mesh, root\./,
  );
});

test("ScriptRegistry and PlayerControllerScript with execution state tracking",async()=>{
  const registry = new ScriptRegistry();
  registry.register("PlayerController", () => new PlayerControllerScript());
  assert.equal(registry.has("PlayerController"), true);
  assert.equal(registry.has("Unknown"), false);

  const script = registry.resolve("PlayerController")!({ entityId: "player", sceneId: "main" });
  const host = new ScriptHost();

  let posX = 0;
  let moveRightActive = 1;
  let jumpActive = false;

  const logs: Array<{ level: string; category: string; data?: Record<string, unknown> | undefined }> = [];

  host.register({
    id: "player_script",
    scriptId: "PlayerController",
    context: {
      entityId: "player",
      sceneId: "main",
      input: {
        getAction: (id) => (id === "player.moveRight" ? moveRightActive : 0),
        isPressed: (id) => (id === "player.jump" ? jumpActive : false),
      },
      transform: {
        getPosition: () => [posX, 0, 0],
        setPosition: (pos) => { posX = pos[0]; },
        translate: (delta) => { posX += delta[0]; },
      },
      log: (level, category, data) => { logs.push({ level, category, data }); },
    },
    script,
  });

  let state = host.getExecutionState("player_script")!;
  assert.equal(state.lifecycleState, "registered");
  assert.equal(state.updateCount, 0);

  await host.startAll();
  state = host.getExecutionState("player_script")!;
  assert.equal(state.lifecycleState, "started");
  assert.deepEqual(state.state, { moveCount: 0, jumpCount: 0 });

  // Update 1: moveRight
  host.update(1 / 60);
  assert.equal(posX, 1.0);
  state = host.getExecutionState("player_script")!;
  assert.equal(state.updateCount, 1);
  assert.equal(state.state?.moveCount, 1);

  // Update 2: jump
  moveRightActive = 0;
  jumpActive = true;
  host.update(1 / 60);
  state = host.getExecutionState("player_script")!;
  assert.equal(state.updateCount, 2);
  assert.equal(state.state?.jumpCount, 1);

  await host.destroyAll();
  const clearedState = host.getExecutionState("player_script");
  assert.equal(clearedState, undefined);
});

test("ScriptHost isolates script runtime errors without silent crash",async()=>{
  const host = new ScriptHost();
  const logs: Array<{ level: string; category: string; data?: Record<string, unknown> | undefined }> = [];

  host.register({
    id: "failing_script",
    scriptId: "FailingScript",
    context: {
      entityId: "bad_entity",
      sceneId: "main",
      log: (level, category, data) => { logs.push({ level, category, data }); },
    },
    script: {
      onStart: () => {
        throw new Error("Intentional start failure");
      },
    },
  });

  await host.startAll();
  const state = host.getExecutionState("failing_script")!;
  assert.equal(state.lifecycleState, "error");
  assert.equal(state.error, "Intentional start failure");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.category, "script.error");

  // Does not throw on update or destroy
  host.update(1 / 60);
  await host.destroyAll();
});

test("ScriptHost error cleanup: onUpdate error still executes onDestroy exactly once", async () => {
  const host = new ScriptHost();
  const events: string[] = [];
  const logs: Array<{ level: string; category: string; data?: Record<string, unknown> | undefined }> = [];

  host.register({
    id: "updating_script",
    scriptId: "UpdatingScript",
    context: {
      entityId: "e1",
      sceneId: "main",
      log: (level, category, data) => { logs.push({ level, category, data }); },
    },
    script: {
      onCreate: () => { events.push("create"); },
      onStart: () => { events.push("start"); },
      onUpdate: () => {
        events.push("update");
        throw new Error("Update failure");
      },
      onStop: () => { events.push("stop"); },
      onDestroy: () => { events.push("destroy"); },
    },
  });

  await host.startAll();
  assert.equal(host.isCreated("updating_script"), true);
  assert.equal(host.isStarted("updating_script"), true);
  assert.equal(host.isStopApplicable("updating_script"), true);
  assert.equal(host.isDestroyApplicable("updating_script"), true);

  host.update(1 / 60);
  const errState = host.getExecutionState("updating_script")!;
  assert.equal(errState.lifecycleState, "error");
  assert.equal(errState.error, "Update failure");

  const updateLog = logs.find(l => l.category === "script.error");
  assert.ok(updateLog);
  assert.equal(updateLog.data?.phase, "onUpdate");

  // destroyAll must execute appropriate cleanup for the script whose lifecycle progressed
  await host.destroyAll();
  assert.deepEqual(events, ["create", "start", "update", "stop", "destroy"]);
  const destroyCount = events.filter(e => e === "destroy").length;
  assert.equal(destroyCount, 1);
});

test("ScriptHost error cleanup: onCreate error prevents onDestroy invocation", async () => {
  const host = new ScriptHost();
  const events: string[] = [];
  const logs: Array<{ level: string; category: string; data?: Record<string, unknown> | undefined }> = [];

  host.register({
    id: "failing_create",
    scriptId: "FailingCreateScript",
    context: {
      entityId: "e2",
      sceneId: "main",
      log: (level, category, data) => { logs.push({ level, category, data }); },
    },
    script: {
      onCreate: () => {
        events.push("create_throw");
        throw new Error("Creation failure");
      },
      onStart: () => { events.push("start"); },
      onStop: () => { events.push("stop"); },
      onDestroy: () => { events.push("destroy"); },
    },
  });

  await host.startAll();
  assert.equal(host.isCreated("failing_create"), false);
  assert.equal(host.isStarted("failing_create"), false);
  assert.equal(host.isStopApplicable("failing_create"), false);
  assert.equal(host.isDestroyApplicable("failing_create"), false);

  const createLog = logs.find(l => l.category === "script.error");
  assert.ok(createLog);
  assert.equal(createLog.data?.phase, "onCreate");

  // destroyAll must NOT invoke onDestroy since onCreate failed
  await host.destroyAll();
  assert.deepEqual(events, ["create_throw"]);
  assert.equal(events.includes("destroy"), false);
});

test("ScriptHost error cleanup: onStart error after successful onCreate executes onDestroy but not onStop", async () => {
  const host = new ScriptHost();
  const events: string[] = [];
  const logs: Array<{ level: string; category: string; data?: Record<string, unknown> | undefined }> = [];

  host.register({
    id: "failing_start",
    scriptId: "FailingStartScript",
    context: {
      entityId: "e3",
      sceneId: "main",
      log: (level, category, data) => { logs.push({ level, category, data }); },
    },
    script: {
      onCreate: () => { events.push("create"); },
      onStart: () => {
        events.push("start_throw");
        throw new Error("Start failure");
      },
      onStop: () => { events.push("stop"); },
      onDestroy: () => { events.push("destroy"); },
    },
  });

  await host.startAll();
  assert.equal(host.isCreated("failing_start"), true);
  assert.equal(host.isStarted("failing_start"), false);
  assert.equal(host.isStopApplicable("failing_start"), false);
  assert.equal(host.isDestroyApplicable("failing_start"), true);

  const startLog = logs.find(l => l.category === "script.error");
  assert.ok(startLog);
  assert.equal(startLog.data?.phase, "onStart");

  // destroyAll cleans up what onCreate allocated by executing onDestroy, but onStop is not called
  await host.destroyAll();
  assert.deepEqual(events, ["create", "start_throw", "destroy"]);
  assert.equal(events.includes("stop"), false);
  assert.equal(events.filter(e => e === "destroy").length, 1);
});

test("ScriptHost reports correct failing phase for onStop and onDestroy errors", async () => {
  const host = new ScriptHost();
  const logs: Array<{ level: string; category: string; data?: Record<string, unknown> | undefined }> = [];

  host.register({
    id: "failing_stop_destroy",
    context: {
      entityId: "e4",
      sceneId: "main",
      log: (level, category, data) => { logs.push({ level, category, data }); },
    },
    script: {
      onCreate: () => {},
      onStart: () => {},
      onStop: () => { throw new Error("Stop failure"); },
      onDestroy: () => { throw new Error("Destroy failure"); },
    },
  });

  await host.startAll();
  await host.destroyAll();

  const stopLog = logs.find(l => l.category === "script.error" && l.data?.phase === "onStop");
  assert.ok(stopLog, "Must log onStop failure");
  assert.equal(stopLog.data?.error, "Stop failure");

  const destroyLog = logs.find(l => l.category === "script.error" && l.data?.phase === "onDestroy");
  assert.ok(destroyLog, "Must log onDestroy failure");
  assert.equal(destroyLog.data?.error, "Destroy failure");
});

test("ScriptHost and PlayerControllerScript support restoreState", async () => {
  const host = new ScriptHost();
  const script = new PlayerControllerScript();

  host.register({
    id: "hero_script",
    scriptId: "PlayerController",
    context: {
      entityId: "hero",
      sceneId: "main",
    },
    script,
  });

  await host.startAll();
  assert.deepEqual(script.getState(), { moveCount: 0, jumpCount: 0 });

  // Restore state
  const restored = await host.restoreScriptState("hero_script", {
    moveCount: 4,
    jumpCount: 2,
    lastAction: "player.jump",
  });
  assert.equal(restored, true);
  assert.deepEqual(script.getState(), {
    moveCount: 4,
    jumpCount: 2,
    lastAction: "player.jump",
  });

  // State reflects in host execution state
  const execState = host.getExecutionState("hero_script");
  assert.deepEqual(execState?.state, {
    moveCount: 4,
    jumpCount: 2,
    lastAction: "player.jump",
  });

  // Verification of canRestoreScriptState and validateScriptRestoreState
  assert.equal(host.hasScript("hero_script"), true);
  assert.equal(host.hasScript("nonexistent"), false);
  assert.equal(host.canRestoreScriptState("hero_script"), true);
  assert.equal(host.canRestoreScriptState("nonexistent"), false);

  // Validation passes on valid payload
  const validRes = host.validateScriptRestoreState("hero_script", { moveCount: 1, jumpCount: 1 });
  assert.equal(validRes.valid, true);

  // Validation fails on corrupt fields
  const corruptMove = host.validateScriptRestoreState("hero_script", { moveCount: "CORRUPT" });
  assert.equal(corruptMove.valid, false);
  assert.ok(corruptMove.error?.includes("moveCount must be a finite number"));

  const corruptJump = host.validateScriptRestoreState("hero_script", { jumpCount: null as any });
  assert.equal(corruptJump.valid, false);
  assert.ok(corruptJump.error?.includes("jumpCount must be a finite number"));

  // Validation fails on non-existent script
  const nonExistentRes = host.validateScriptRestoreState("nonexistent", { moveCount: 1 });
  assert.equal(nonExistentRes.valid, false);

  // Direct script restoreState throws on invalid payload
  assert.throws(
    () => script.restoreState({ moveCount: "INVALID" as any }),
    /Cannot restore invalid PlayerController state/,
  );

  await host.destroyAll();
});

test("ScriptHost rejects restoration for scripts that do not implement restoreState", async () => {
  const host = new ScriptHost();
  host.register({
    id: "readonly_script",
    scriptId: "ReadOnlyScript",
    context: {
      entityId: "npc",
      sceneId: "main",
    },
    script: {
      onCreate: () => {},
    },
  });

  await host.startAll();
  assert.equal(host.hasScript("readonly_script"), true);
  assert.equal(host.canRestoreScriptState("readonly_script"), false);

  const val = host.validateScriptRestoreState("readonly_script", { someKey: 123 });
  assert.equal(val.valid, false);
  assert.ok(val.error?.includes("does not support state restoration"));

  assert.equal(await host.restoreScriptState("readonly_script", { someKey: 123 }), false);
  await host.destroyAll();
});

test("ScriptHost prepareScriptRestore supports two-phase commit and rollback for PlayerControllerScript", async () => {
  const host = new ScriptHost();
  const script = new PlayerControllerScript();

  host.register({
    id: "hero",
    scriptId: "PlayerController",
    context: {
      entityId: "hero",
      sceneId: "main",
    },
    script,
  });

  await host.startAll();
  assert.deepEqual(script.getState(), { moveCount: 0, jumpCount: 0 });

  // Phase 3: prepare
  const prepared = await host.prepareScriptRestore("hero", {
    moveCount: 10,
    jumpCount: 5,
    lastAction: "player.jump",
  });

  // Verification: preparation does NOT mutate live state
  assert.deepEqual(script.getState(), { moveCount: 0, jumpCount: 0 });

  // Phase 4: commit
  await prepared.commit();
  assert.deepEqual(script.getState(), {
    moveCount: 10,
    jumpCount: 5,
    lastAction: "player.jump",
  });

  // Rollback restores previous state
  await prepared.rollback();
  assert.deepEqual(script.getState(), { moveCount: 0, jumpCount: 0 });

  await host.destroyAll();
});

test("ScriptHost handles adversarial script mutating before throw with rollback restoring pre-transaction state", async () => {
  const host = new ScriptHost();

  class AdversarialScript {
    value = 5;
    getState() {
      return { value: this.value };
    }
    prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
      const oldValue = this.value;
      const nextValue = state.value as number;
      const throwAfterMutation = Boolean(state.throwAfterMutation);
      return {
        commit: () => {
          this.value = nextValue;
          if (throwAfterMutation) {
            throw new Error("Adversarial throw AFTER mutation");
          }
        },
        rollback: () => {
          this.value = oldValue;
        },
      };
    }
  }

  const script = new AdversarialScript();
  host.register({
    id: "adv",
    context: {
      entityId: "adv",
      sceneId: "main",
    },
    script,
  });

  await host.startAll();
  assert.deepEqual(script.getState(), { value: 5 });

  // Prepare restore with throwAfterMutation: true
  const prepared = await host.prepareScriptRestore("adv", {
    value: 99,
    throwAfterMutation: true,
  });

  // Preparation does not mutate live state
  assert.deepEqual(script.getState(), { value: 5 });

  // Commit executes mutation and then throws
  await assert.rejects(
    async () => {
      await prepared.commit();
    },
    /Adversarial throw AFTER mutation/,
  );

  // Notice mutation occurred before throw (value is 99)
  assert.equal(script.value, 99);

  // Rollback restores value back to 5
  await prepared.rollback();
  assert.equal(script.value, 5);
  assert.deepEqual(script.getState(), { value: 5 });

  await host.destroyAll();
});

test("ScriptHost rollback failure propagates error when rollback throws", async () => {
  const host = new ScriptHost();

  class BrokenRollbackScript {
    value = 1;
    throwOnRollback = false;
    getState() {
      return { value: this.value };
    }
    prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
      const oldValue = this.value;
      const nextValue = state.value as number;
      return {
        commit: () => {
          this.value = nextValue;
        },
        rollback: () => {
          if (this.throwOnRollback) {
            throw new Error("Unrecoverable rollback error");
          }
          this.value = oldValue;
        },
      };
    }
  }

  const script = new BrokenRollbackScript();
  host.register({
    id: "broken",
    context: {
      entityId: "broken",
      sceneId: "main",
    },
    script,
  });

  await host.startAll();

  const prep = await host.prepareScriptRestore("broken", { value: 99 });
  await prep.commit();
  assert.equal(script.value, 99);

  script.throwOnRollback = true;
  // If rollback is called, it must not be silently swallowed
  await assert.rejects(
    async () => {
      await prep.rollback();
    },
    /Unrecoverable rollback error/,
  );

  await host.destroyAll();
});

test("ScriptHost rejects legacy-only restoreState in prepareScriptRestore but permits direct restoreScriptState", async () => {
  const host = new ScriptHost();

  class LegacyScript {
    value = 1;
    getState() {
      return { value: this.value };
    }
    restoreState(state: Record<string, unknown>) {
      this.value = state.value as number;
    }
  }

  host.register({
    id: "legacy",
    context: {
      entityId: "legacy",
      sceneId: "main",
    },
    script: new LegacyScript(),
  });

  await host.startAll();

  assert.equal(host.canRestoreScriptState("legacy"), true);
  assert.equal(host.canPrepareTransactionalRestore("legacy"), false);

  // Transactional preparation must be rejected
  await assert.rejects(
    async () => {
      await host.prepareScriptRestore("legacy", { value: 2 });
    },
    /does not support transactional state restoration/,
  );

  // Legacy direct restore still works non-transactionally
  const directResult = await host.restoreScriptState("legacy", { value: 42 });
  assert.equal(directResult, true);
  assert.equal(host.getExecutionState("legacy")?.state?.value, 42);

  await host.destroyAll();
});



