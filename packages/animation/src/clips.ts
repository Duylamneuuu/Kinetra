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
  if(!clip.id) issues.push("clip id is required");
  if(!clip.name) issues.push("clip name is required");
  if(!(clip.duration>0)) issues.push("clip duration must be positive");

  let previous=-Infinity;
  for(const event of clip.events){
    if(event.time<0||event.time>clip.duration){
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
