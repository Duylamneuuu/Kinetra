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

export function validateClipMetadata(clip:AnimationClipMetadata):string[]{
  const issues:string[]=[];
  if(typeof clip!=="object"||clip===null){
    return ["clip must be an object"];
  }
  if(!clip.id) issues.push("clip id is required");
  if(!clip.name) issues.push("clip name is required");
  const durationOk=typeof clip.duration==="number"&&Number.isFinite(clip.duration)&&clip.duration>0;
  if(!durationOk) issues.push("clip duration must be a finite positive number");

  if(!Array.isArray(clip.events)){
    issues.push("clip events must be an array");
    return issues;
  }

  let previous=-Infinity;
  for(const event of clip.events){
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
