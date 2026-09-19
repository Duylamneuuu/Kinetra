import assert from "node:assert/strict";
import test from "node:test";
import { ScriptHost, SceneLifecycle, instantiatePrefab } from "../src/index.js";

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
