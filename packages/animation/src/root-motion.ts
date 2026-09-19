export type RootMotionMode = "none" | "extract-xz" | "extract-xyz" | "extract-xz-yaw";

export interface RootMotionSample {
  time:number;
  position:[number,number,number];
  yaw:number;
}

export interface RootMotionDelta {
  time:number;
  translation:[number,number,number];
  yaw:number;
}

export interface RootMotionResult {
  mode:RootMotionMode;
  deltas:RootMotionDelta[];
  inPlace:RootMotionSample[];
}

export function extractRootMotion(
  samples:RootMotionSample[],
  mode:RootMotionMode,
):RootMotionResult{
  if(samples.length===0) return{mode,deltas:[],inPlace:[]};

  const deltas:RootMotionDelta[]=[];
  const first=samples[0]!;
  const inPlace=samples.map(sample=>({
    time:sample.time,
    position:[...sample.position] as [number,number,number],
    yaw:sample.yaw,
  }));

  for(let i=1;i<samples.length;i++){
    const previous=samples[i-1]!;
    const current=samples[i]!;
    const dx=current.position[0]-previous.position[0];
    const dy=current.position[1]-previous.position[1];
    const dz=current.position[2]-previous.position[2];
    const dyaw=current.yaw-previous.yaw;

    deltas.push({
      time:current.time,
      translation:
        mode==="extract-xyz"
          ? [dx,dy,dz]
          : mode==="extract-xz" || mode==="extract-xz-yaw"
            ? [dx,0,dz]
            : [0,0,0],
      yaw:mode==="extract-xz-yaw"?dyaw:0,
    });
  }

  if(mode!=="none"){
    for(const sample of inPlace){
      sample.position[0]-=sample.position[0]-first.position[0];
      sample.position[2]-=sample.position[2]-first.position[2];
      if(mode==="extract-xyz"){
        sample.position[1]-=sample.position[1]-first.position[1];
      }
      if(mode==="extract-xz-yaw"){
        sample.yaw=first.yaw;
      }
    }
  }

  return{mode,deltas,inPlace};
}
