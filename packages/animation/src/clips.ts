export interface AnimationEventDefinition {
  time:number;
  name:string;
  payload?:Record<string,unknown>;
}

export interface AnimationClipMetadata {
  id:string;
  name:string;
  duration:number;
  sourceAssetId:string;
  skeletonSignature?:string;
  rootMotionMode?:"none"|"extract-xz"|"extract-xyz"|"extract-xz-yaw";
  events:AnimationEventDefinition[];
}

const ROOT_MOTION_MODES:readonly string[]=["none","extract-xz","extract-xyz","extract-xz-yaw"];

export function validateClipMetadata(clip:AnimationClipMetadata):string[]{
  const issues:string[]=[];
  if(typeof clip!=="object"||clip===null){
    return ["clip must be an object"];
  }
  if(!clip.id) issues.push("clip id is required");
  if(!clip.name) issues.push("clip name is required");
  const durationOk=typeof clip.duration==="number"&&Number.isFinite(clip.duration)&&clip.duration>0;
  if(!durationOk) issues.push("clip duration must be a finite positive number");

  if(clip.rootMotionMode!==undefined&&!ROOT_MOTION_MODES.includes(clip.rootMotionMode as string)){
    issues.push(`clip rootMotionMode "${String(clip.rootMotionMode)}" must be one of ${ROOT_MOTION_MODES.join(", ")}`);
  }

  if(!Array.isArray(clip.events)){
    issues.push("clip events must be an array");
    return issues;
  }

  let previous=-Infinity;
  for(const event of clip.events){
    if(typeof event?.name!=="string"||event.name.length===0){
      issues.push("every event needs a non-empty string name");
    }
    if(typeof event?.time!=="number"||!Number.isFinite(event.time)){
      issues.push(`event "${event?.name}" has a non-finite time`);
      continue;
    }
    if(event.time<0||(durationOk&&event.time>clip.duration)){
      issues.push(`event "${event.name}" is outside clip duration`);
    }
    if(event.time<previous){
      issues.push("events must be sorted by time");
      break;
    }
    previous=event.time;
  }
  return issues;
}
