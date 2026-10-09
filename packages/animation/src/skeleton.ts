import { createHash } from "node:crypto";

export type HumanoidBone =
  | "root" | "hips" | "spine" | "chest" | "neck" | "head"
  | "leftShoulder" | "leftUpperArm" | "leftLowerArm" | "leftHand"
  | "rightShoulder" | "rightUpperArm" | "rightLowerArm" | "rightHand"
  | "leftUpperLeg" | "leftLowerLeg" | "leftFoot" | "leftToes"
  | "rightUpperLeg" | "rightLowerLeg" | "rightFoot" | "rightToes";

export interface SkeletonProfile {
  id: string;
  bones: Partial<Record<HumanoidBone,string>>;
}

export interface SkeletonProfileDiagnostic {
  severity:"warning"|"error";
  code:string;
  message:string;
  semanticBone?:HumanoidBone;
}

function compareCodePoints(a:string,b:string):number{
  return a<b?-1:a>b?1:0;
}

/** The raw bone map of a profile; `{}` when JSON/MCP input has no usable `bones` object. */
function rawBoneMap(profile:SkeletonProfile):Record<string,unknown>{
  return (profile&&typeof profile.bones==="object"&&profile.bones!==null&&!Array.isArray(profile.bones)
    ?profile.bones:{}) as Record<string,unknown>;
}

/** Bone map entries that actually name a bone (JSON/MCP input may carry null/undefined). */
function boneEntries(profile:SkeletonProfile):Array<[HumanoidBone,string]>{
  return Object.entries(rawBoneMap(profile)).filter(
    (entry):entry is [HumanoidBone,string]=>typeof entry[1]==="string",
  );
}

const REQUIRED: HumanoidBone[]=[
  "hips","spine","head",
  "leftUpperArm","leftLowerArm","leftHand",
  "rightUpperArm","rightLowerArm","rightHand",
  "leftUpperLeg","leftLowerLeg","leftFoot",
  "rightUpperLeg","rightLowerLeg","rightFoot",
];

export function validateSkeletonProfile(profile:SkeletonProfile):SkeletonProfileDiagnostic[]{
  const diagnostics:SkeletonProfileDiagnostic[]=[];
  const physical=new Map<string,HumanoidBone>();

  const rawBones=rawBoneMap(profile);
  for(const [semantic,name] of Object.entries(rawBones) as Array<[HumanoidBone,unknown]>){
    if(typeof name!=="string"||!name.trim()){
      diagnostics.push({
        severity:"error",code:"skeleton.bone.empty",
        message:`Bone mapping for ${semantic} is empty`,semanticBone:semantic,
      });
      continue;
    }
    const prior=physical.get(name);
    if(prior){
      diagnostics.push({
        severity:"error",code:"skeleton.bone.duplicate-target",
        message:`Physical bone "${name}" is mapped by both ${prior} and ${semantic}`,
        semanticBone:semantic,
      });
    }else{
      physical.set(name,semantic);
    }
  }

  for(const semantic of REQUIRED){
    if(!rawBones[semantic]){
      diagnostics.push({
        severity:"warning",code:"skeleton.required.missing",
        message:`Recommended humanoid bone "${semantic}" is not mapped`,
        semanticBone:semantic,
      });
    }
  }

  return diagnostics;
}

export function skeletonSignature(profile:SkeletonProfile):string{
  const canonical=boneEntries(profile)
    .sort(([a],[b])=>compareCodePoints(a,b))
    .map(([semantic,name])=>`${semantic}=${name}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export interface RetargetBonePair {
  semantic:HumanoidBone;
  sourceBone:string;
  targetBone:string;
}

export interface RetargetPlan {
  sourceSignature:string;
  targetSignature:string;
  pairs:RetargetBonePair[];
  missingOnTarget:HumanoidBone[];
}

export function buildRetargetPlan(
  source:SkeletonProfile,
  target:SkeletonProfile,
):RetargetPlan{
  const pairs:RetargetBonePair[]=[];
  const missingOnTarget:HumanoidBone[]=[];

  const targetBones=rawBoneMap(target);
  for(const [semantic,sourceBone] of boneEntries(source)){
    const targetBone=Object.hasOwn(targetBones,semantic)?targetBones[semantic]:undefined;
    if(typeof targetBone==="string"&&targetBone!==""){
      pairs.push({semantic,sourceBone,targetBone});
    }else{
      missingOnTarget.push(semantic);
    }
  }

  pairs.sort((a,b)=>compareCodePoints(a.semantic,b.semantic));
  missingOnTarget.sort(compareCodePoints);

  return{
    sourceSignature:skeletonSignature(source),
    targetSignature:skeletonSignature(target),
    pairs,
    missingOnTarget,
  };
}

export function retargetCacheKey(input:{
  sourceClipId:string;
  source:SkeletonProfile;
  target:SkeletonProfile;
  settings?:Record<string,unknown>;
}):string{
  const stable=(value:unknown):unknown=>{
    if(Array.isArray(value)) return value.map(stable);
    if(value && typeof value==="object"){
      const result:Record<string,unknown>={};
      for(const key of Object.keys(value as Record<string,unknown>).sort()){
        result[key]=stable((value as Record<string,unknown>)[key]);
      }
      return result;
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(stable({
    sourceClipId:input.sourceClipId,
    source:skeletonSignature(input.source),
    target:skeletonSignature(input.target),
    settings:input.settings??{},
  }))).digest("hex");
}
