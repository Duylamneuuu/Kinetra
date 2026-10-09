import {solveTwoBoneIk,type IkVec3} from "@kinetra/animation";

/** Orb Run's runner leg rig, in metres. The pelvis sits `pelvisHeight` above the standing ground. */
export const RUNNER_LEG_RIG={
  thighLength:0.45,
  shinLength:0.45,
  ankleHeight:0.08,
  hipOffsetX:0.12,
  /** Standing pelvis height: just under full leg extension so the knee keeps a slight bend. */
  pelvisHeight:0.95
} as const;

export type FootSide="left"|"right";

export interface PlantedFoot{
  side:FootSide;
  hip:IkVec3;
  knee:IkVec3;
  ankle:IkVec3;
  /** Ankle height the solver was asked for (ground + ankle offset). */
  targetY:number;
  reachable:boolean;
  converged:boolean;
  /** Distance from solved ankle to the target. */
  error:number;
}

export interface FootPlan{
  pelvis:IkVec3;
  /** How far the pelvis was lowered to keep the lower foot reachable (>= 0). */
  pelvisDrop:number;
  feet:[PlantedFoot,PlantedFoot];
}

export interface FootPlanInput{
  /** World position of the pelvis root before IK (x, z used; y is the standing height above `baseGround`). */
  position:IkVec3;
  /** Ground height under the character origin, used as the pelvis reference. */
  baseGround:number;
  leftGround:number;
  rightGround:number;
}

const REACH=RUNNER_LEG_RIG.thighLength+RUNNER_LEG_RIG.shinLength;

function assertFinite(name:string,value:number):void{
  if(!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
}

/**
 * Pure foot-placement plan: lower the pelvis so the lower foot can reach its
 * ground point, then solve both legs with the engine's two-bone IK, knees
 * pointing forward (+Z). No Three.js, no scene access: the caller applies the
 * result through the command bus / animation runtime.
 */
export function planFootPlacement(input:FootPlanInput):FootPlan{
  assertFinite("position.x",input.position[0]);
  assertFinite("position.z",input.position[2]);
  assertFinite("baseGround",input.baseGround);
  assertFinite("leftGround",input.leftGround);
  assertFinite("rightGround",input.rightGround);
  const lowest=Math.min(input.leftGround,input.rightGround);
  // Drop the pelvis only as far as the lowest foot needs; never lift it.
  const drop=Math.max(0,input.baseGround-lowest);
  const pelvisY=input.baseGround+RUNNER_LEG_RIG.pelvisHeight-drop;
  const pelvis:IkVec3=[input.position[0],pelvisY,input.position[2]];
  const plant=(side:FootSide,ground:number):PlantedFoot=>{
    const sign=side==="left"?-1:1;
    const hip:IkVec3=[pelvis[0]+sign*RUNNER_LEG_RIG.hipOffsetX,pelvis[1],pelvis[2]];
    // Rest pose with exact bone lengths and a slight forward knee bend (the solver keeps the input lengths).
    const bend=0.05;
    const knee:IkVec3=[hip[0],hip[1]-Math.sqrt(RUNNER_LEG_RIG.thighLength**2-bend**2),hip[2]+bend];
    const ankle:IkVec3=[hip[0],knee[1]-Math.sqrt(RUNNER_LEG_RIG.shinLength**2-bend**2),hip[2]];
    const targetY=ground+RUNNER_LEG_RIG.ankleHeight;
    const target:IkVec3=[hip[0],targetY,hip[2]];
    const solved=solveTwoBoneIk(hip,knee,ankle,target,{pole:[hip[0],hip[1]-RUNNER_LEG_RIG.thighLength,hip[2]+1]});
    if(!solved.success) throw new Error(`foot IK failed: ${solved.diagnostics.map((d)=>d.code).join(",")}`);
    return {side,hip,knee:solved.positions[1]!,ankle:solved.positions[2]!,targetY,reachable:solved.reachable,converged:solved.converged,error:solved.error};
  };
  return {pelvis,pelvisDrop:drop,feet:[plant("left",input.leftGround),plant("right",input.rightGround)]};
}
