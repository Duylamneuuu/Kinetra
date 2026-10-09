import {evaluateBlendSpace1D,validateBlendSpace,type BlendSpace1DDefinition,type BlendSpaceWeight} from "@kinetra/animation";

/** Orb Run's runner locomotion: a pure 1D blend space driven by horizontal speed (m/s). */
export const ORB_RUN_LOCOMOTION:BlendSpace1DDefinition={
  schemaVersion:1,
  kind:"1d",
  id:"orb-run.locomotion",
  parameter:"speed",
  samples:[
    {clipId:"idle",position:0},
    {clipId:"walk",position:1.5},
    {clipId:"run",position:4}
  ]
};

export function locomotionWeights(speed:number):BlendSpaceWeight[]{
  return evaluateBlendSpace1D(ORB_RUN_LOCOMOTION,Math.max(0,speed));
}

/** Horizontal (XZ) speed between two positions over dt seconds. */
export function horizontalSpeed(from:readonly [number,number,number],to:readonly [number,number,number],dt:number):number{
  if(!(dt>0)) throw new RangeError("dt must be > 0");
  return Math.hypot(to[0]-from[0],to[2]-from[2])/dt;
}

export function locomotionDiagnostics():ReturnType<typeof validateBlendSpace>{
  return validateBlendSpace(ORB_RUN_LOCOMOTION);
}
