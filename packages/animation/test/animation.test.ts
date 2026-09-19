import assert from "node:assert/strict";
import test from "node:test";
import {
  AnimationGraphMachine,
  buildRetargetPlan,
  extractRootMotion,
  retargetCacheKey,
  skeletonSignature,
  validateAnimationGraph,
  validateSkeletonProfile,
  type AnimationGraphDefinition,
  type SkeletonProfile,
} from "../src/index.js";

const source:SkeletonProfile={
  id:"mixamo",
  bones:{
    hips:"mixamorigHips",spine:"mixamorigSpine",head:"mixamorigHead",
    leftUpperArm:"mixamorigLeftArm",leftLowerArm:"mixamorigLeftForeArm",leftHand:"mixamorigLeftHand",
    rightUpperArm:"mixamorigRightArm",rightLowerArm:"mixamorigRightForeArm",rightHand:"mixamorigRightHand",
    leftUpperLeg:"mixamorigLeftUpLeg",leftLowerLeg:"mixamorigLeftLeg",leftFoot:"mixamorigLeftFoot",
    rightUpperLeg:"mixamorigRightUpLeg",rightLowerLeg:"mixamorigRightLeg",rightFoot:"mixamorigRightFoot",
  },
};
const target:SkeletonProfile={
  id:"hero",
  bones:{
    hips:"Hips",spine:"Spine",head:"Head",
    leftUpperArm:"UpperArm.L",leftLowerArm:"LowerArm.L",leftHand:"Hand.L",
    rightUpperArm:"UpperArm.R",rightLowerArm:"LowerArm.R",rightHand:"Hand.R",
    leftUpperLeg:"Thigh.L",leftLowerLeg:"Shin.L",leftFoot:"Foot.L",
    rightUpperLeg:"Thigh.R",rightLowerLeg:"Shin.R",rightFoot:"Foot.R",
  },
};

test("skeleton profiles produce deterministic signatures and retarget pairs",()=>{
  assert.equal(validateSkeletonProfile(source).filter(d=>d.severity==="error").length,0);
  assert.equal(skeletonSignature(source),skeletonSignature(structuredClone(source)));
  const plan=buildRetargetPlan(source,target);
  assert.ok(plan.pairs.some(pair=>pair.semantic==="hips"&&pair.targetBone==="Hips"));
  assert.equal(plan.missingOnTarget.length,0);
});

test("retarget cache key changes when settings change",()=>{
  const a=retargetCacheKey({sourceClipId:"walk",source,target,settings:{scale:1}});
  const b=retargetCacheKey({sourceClipId:"walk",source,target,settings:{scale:2}});
  assert.notEqual(a,b);
});

test("root motion extracts XZ and yaw while making clip in-place",()=>{
  const result=extractRootMotion([
    {time:0,position:[0,1,0],yaw:0},
    {time:0.5,position:[1,1,2],yaw:0.2},
    {time:1,position:[2,1,4],yaw:0.5},
  ],"extract-xz-yaw");
  assert.deepEqual(result.deltas[0]?.translation,[1,0,2]);
  assert.equal(result.deltas[1]?.yaw,0.3);
  assert.deepEqual(result.inPlace[2]?.position,[0,1,0]);
  assert.equal(result.inPlace[2]?.yaw,0);
});

function graph():AnimationGraphDefinition{
  return{
    schemaVersion:1,
    entryState:"idle",
    parameters:{
      speed:{type:"number",default:0},
      grounded:{type:"bool",default:true},
      jump:{type:"trigger"},
    },
    states:[
      {id:"idle",clipId:"idle"},
      {id:"run",clipId:"run"},
      {id:"jump",clipId:"jump",loop:false},
    ],
    transitions:[
      {id:"jump",from:"idle",to:"jump",priority:10,conditions:[{parameter:"jump",op:"triggered"}]},
      {id:"run",from:"idle",to:"run",conditions:[{parameter:"speed",op:">",value:0.1}]},
    ],
  };
}

test("animation graph uses priorities and consumes triggers",()=>{
  const machine=new AnimationGraphMachine(graph());
  machine.set("speed",1);
  machine.trigger("jump");
  const transition=machine.evaluate();
  assert.equal(transition?.transitionId,"jump");
  assert.equal(machine.state,"jump");
});

test("invalid animation graph reports missing state and parameter",()=>{
  const bad=graph();
  bad.entryState="missing";
  bad.transitions.push({
    id:"bad",from:"idle",to:"missing",conditions:[{parameter:"wat",op:"==",value:true}],
  });
  const codes=validateAnimationGraph(bad).map(d=>d.code);
  assert.ok(codes.includes("anim.entry.missing"));
  assert.ok(codes.includes("anim.transition.to.missing"));
  assert.ok(codes.includes("anim.condition.parameter.missing"));
});
