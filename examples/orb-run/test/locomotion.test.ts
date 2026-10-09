import assert from "node:assert/strict";
import {test} from "node:test";
import {horizontalSpeed,locomotionDiagnostics,locomotionWeights} from "../src/index.js";

const w=(s:number)=>Object.fromEntries(locomotionWeights(s).map((x)=>[x.clipId,x.weight]));

test("locomotion blend space is valid",()=>{assert.deepEqual(locomotionDiagnostics(),[]);});
test("idle, walk and run at sample speeds",()=>{
  assert.deepEqual(w(0),{idle:1});
  assert.deepEqual(w(1.5),{walk:1});
  assert.deepEqual(w(9),{run:1});
});
test("weights blend and sum to 1",()=>{
  const b=w(2.75);
  assert.ok(Math.abs(b.walk!-0.5)<1e-9&&Math.abs(b.run!-0.5)<1e-9);
  for(const s of [0.1,0.7,1.9,3.3]) assert.ok(Math.abs(locomotionWeights(s).reduce((a,x)=>a+x.weight,0)-1)<1e-9);
});
test("negative speed clamps to idle; speed from positions",()=>{
  assert.deepEqual(w(-3),{idle:1});
  assert.equal(horizontalSpeed([0,5,0],[3,9,4],1),5);
  assert.throws(()=>horizontalSpeed([0,0,0],[1,0,0],0),RangeError);
});
