import assert from "node:assert/strict";
import {test} from "node:test";
import {RUNNER_LEG_RIG,planFootPlacement} from "../src/index.js";

const dist=(a:readonly number[],b:readonly number[])=>Math.hypot(a[0]!-b[0]!,a[1]!-b[1]!,a[2]!-b[2]!);
const plan=(l:number,r:number,base=0)=>planFootPlacement({position:[2,0,3],baseGround:base,leftGround:l,rightGround:r});

test("flat ground: both ankles land on ground + ankle offset, bone lengths preserved",()=>{
  const p=plan(0,0);
  assert.equal(p.pelvisDrop,0);
  for(const f of p.feet){
    assert.ok(f.reachable&&f.converged);
    assert.ok(Math.abs(f.ankle[1]-RUNNER_LEG_RIG.ankleHeight)<1e-6);
    assert.ok(Math.abs(dist(f.hip,f.knee)-RUNNER_LEG_RIG.thighLength)<1e-6);
    assert.ok(Math.abs(dist(f.knee,f.ankle)-RUNNER_LEG_RIG.shinLength)<1e-6);
    assert.ok(f.knee[2]>f.hip[2],"knee bends forward");
  }
});
test("a step up under one foot plants that foot on the step; the other stays on the floor",()=>{
  const p=plan(0,0.2);
  const [l,r]=p.feet;
  assert.ok(Math.abs(l.ankle[1]-0.08)<1e-6&&Math.abs(r.ankle[1]-0.28)<1e-6);
  assert.ok(r.reachable&&l.reachable);
  assert.equal(p.pelvisDrop,0);
});
test("a drop-off lowers the pelvis by exactly the lowest foot's depth so both feet still plant",()=>{
  const p=plan(0,-0.3);
  assert.ok(Math.abs(p.pelvisDrop-0.3)<1e-12);
  assert.ok(Math.abs(p.pelvis[1]-(RUNNER_LEG_RIG.pelvisHeight-0.3))<1e-12);
  for(const f of p.feet){assert.ok(f.reachable);assert.ok(Math.abs(f.ankle[1]-f.targetY)<1e-6);}
  assert.ok(Math.abs(p.feet[1].ankle[1]-(-0.3+0.08))<1e-6);
});
test("a ledge far above the hip is reported unreachable and the leg stretches toward it",()=>{
  const p=plan(0,2);
  const r=p.feet[1];
  assert.equal(r.reachable,false);
  assert.equal(r.converged,false);
  assert.ok(r.error>0.2);
  assert.ok(Math.abs(dist(r.hip,r.ankle)-(RUNNER_LEG_RIG.thighLength+RUNNER_LEG_RIG.shinLength))<1e-6);
});
test("deterministic, x/z follow the character, non-finite input is rejected",()=>{
  assert.deepEqual(plan(0.1,0.15),plan(0.1,0.15));
  const p=plan(0,0);
  assert.equal(p.pelvis[0],2);assert.equal(p.pelvis[2],3);
  assert.ok(Math.abs(p.feet[0].hip[0]-(2-RUNNER_LEG_RIG.hipOffsetX))<1e-12);
  assert.throws(()=>plan(Number.NaN,0),RangeError);
  assert.throws(()=>planFootPlacement({position:[Infinity,0,0],baseGround:0,leftGround:0,rightGround:0}),RangeError);
});
