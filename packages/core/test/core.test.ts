import assert from "node:assert/strict";
import test from "node:test";
import { ScriptHost, SceneLifecycle, instantiatePrefab, ScriptRegistry, PlayerControllerScript } from "../src/index.js";

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

