import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AcceptanceRunner,
  runProcessSmoke,
  type RuntimeInput,
  type RuntimeLog,
  type RuntimeMetrics,
  type RuntimeProbe,
  type RuntimeSnapshot,
} from "../src/index.js";

class FakeProbe implements RuntimeProbe{
  state:RuntimeSnapshot={running:false,state:{player:{x:0,jumped:false}}};
  logEntries:RuntimeLog[]=[];
  metricValues:RuntimeMetrics={fps:60,drawCalls:20};
  frame=Buffer.from("frame-a");

  async start(sceneId:string,seed:number){
    this.state={running:true,sceneId,state:{player:{x:seed,jumped:false}}};
  }
  async stop(){this.state={running:false,state:this.state.state};}
  async input(event:RuntimeInput){
    if(event.action==="move.right"){
      (this.state.state.player as {x:number}).x+=typeof event.value==="number"?event.value:1;
    }
    if(event.action==="jump"){
      (this.state.state.player as {jumped:boolean}).jumped=true;
    }
  }
  async wait(_milliseconds:number){}
  async snapshot(){return structuredClone(this.state);}
  async logs(){return structuredClone(this.logEntries);}
  async captureFrame(){return new Uint8Array(this.frame);}
  async metrics(){return structuredClone(this.metricValues);}
}

test("semantic acceptance scenario passes with state, log, metric and image assertions",async()=>{
  const probe=new FakeProbe();
  const hash=createHash("sha256").update(probe.frame).digest("hex");
  const report=await new AcceptanceRunner(probe).run({
    schemaVersion:1,suite:"shipping-smoke",seed:0,target:"runtime",
    steps:[
      {type:"runtime.start",sceneId:"main"},
      {type:"input",action:"move.right",phase:"press",value:2},
      {type:"input",action:"jump",phase:"press"},
      {type:"assert.equal",path:"state.player.x",expected:2},
      {type:"assert.equal",path:"state.player.jumped",expected:true},
      {type:"assert.logAbsent",minimumLevel:"error"},
      {type:"assert.metricMin",metric:"fps",min:30},
      {type:"assert.metricMax",metric:"drawCalls",max:100},
      {type:"assert.screenshotSha256",sha256:hash},
      {type:"runtime.stop"},
    ],
  });

  assert.equal(report.passed,true);
  assert.equal(report.steps.length,10);
});

test("acceptance stops at first failed proof and returns machine-readable failure",async()=>{
  const report=await new AcceptanceRunner(new FakeProbe()).run({
    schemaVersion:1,suite:"failure",seed:0,target:"runtime",
    steps:[
      {type:"runtime.start",sceneId:"main"},
      {type:"assert.equal",path:"state.player.x",expected:99},
      {type:"runtime.stop"},
    ],
  });
  assert.equal(report.passed,false);
  assert.equal(report.steps.length,2);
  assert.match(report.steps[1]?.message??"",/Expected/);
});

test("process smoke can validate a packaged-process style command",async()=>{
  const result=await runProcessSmoke({
    executable:process.execPath,
    args:["-e","console.log('KINETRA_SMOKE_OK')"],
    timeoutMs:5_000,
  });
  assert.equal(result.exitCode,0);
  assert.match(result.stdout,/KINETRA_SMOKE_OK/);
});
