/**
 * Locomotion blend spaces (1D and 2D) as a pure, text-backed contract.
 *
 * A blend space maps one or two numeric parameters (for example `speed`, or
 * `velocityX`/`velocityZ`) to a set of weighted clips. This module owns only
 * the data contract, validation and deterministic weight evaluation. It does
 * not touch Three.js; a runtime adapter turns the returned weights into
 * `AnimationAction` weights.
 *
 * 2D weights use gradient band interpolation (Rune Skovbo Johansen, 2009,
 * "Automated Semi-Procedural Animation for Character Locomotion"), the same
 * family of algorithm commonly used for freeform cartesian blend trees. It is
 * implemented from the published description; no third-party code is copied.
 */

export interface BlendSpaceSample1D {
  clipId:string;
  position:number;
}

export interface BlendSpaceSample2D {
  clipId:string;
  position:readonly [number,number];
}

export interface BlendSpace1DDefinition {
  schemaVersion:1;
  kind:"1d";
  id:string;
  /** Name of the graph parameter that drives the blend. */
  parameter:string;
  samples:BlendSpaceSample1D[];
}

export interface BlendSpace2DDefinition {
  schemaVersion:1;
  kind:"2d";
  id:string;
  /** Names of the graph parameters for the X and Y axes. */
  parameters:readonly [string,string];
  samples:BlendSpaceSample2D[];
}

export type BlendSpaceDefinition=BlendSpace1DDefinition|BlendSpace2DDefinition;

export interface BlendSpaceDiagnostic {
  code:string;
  message:string;
  remediation:string;
}

export interface BlendSpaceWeight {
  clipId:string;
  weight:number;
}

/** Weights below this are dropped from evaluation output. */
export const BLEND_SPACE_WEIGHT_EPSILON=1e-6;

const MIN_SAMPLE_SEPARATION=1e-6;

/** Locale-independent ordering so evaluation output never depends on the host's ICU/locale. */
function compareCodePoints(a:string,b:string):number{
  return a<b?-1:a>b?1:0;
}

function isFiniteNumber(value:unknown):value is number{
  return typeof value==="number" && Number.isFinite(value);
}

export function validateBlendSpace(space:BlendSpaceDefinition):BlendSpaceDiagnostic[]{
  const diagnostics:BlendSpaceDiagnostic[]=[];
  if(typeof space!=="object" || space===null){
    diagnostics.push({code:"anim.blendSpace.invalid",message:"Blend space must be an object",remediation:"Pass a { schemaVersion, kind, id, samples } blend-space definition."});
    return diagnostics;
  }
  const label=`Blend space "${String(space.id)}"`;

  if(space.schemaVersion!==1){
    diagnostics.push({
      code:"anim.blendSpace.schemaVersion",
      message:`${label} has unsupported schemaVersion ${String(space.schemaVersion)}`,
      remediation:"Set schemaVersion to 1.",
    });
  }
  if(typeof space.id!=="string" || space.id.length===0){
    diagnostics.push({code:"anim.blendSpace.id.empty",message:"Blend space has no id",remediation:"Give the blend space a stable id."});
  }

  if(space.kind==="1d"){
    if(typeof space.parameter!=="string" || space.parameter.length===0){
      diagnostics.push({code:"anim.blendSpace.parameter.empty",message:`${label} has no parameter`,remediation:"Name the number parameter that drives the blend, e.g. \"speed\"."});
    }
  }else if(space.kind==="2d"){
    const [x,y]=Array.isArray(space.parameters)?space.parameters:[];
    if(typeof x!=="string" || typeof y!=="string" || !x || !y || space.parameters.length!==2){
      diagnostics.push({code:"anim.blendSpace.parameter.empty",message:`${label} needs two parameters`,remediation:"Name the X and Y number parameters, e.g. [\"velocityX\", \"velocityZ\"]."});
    }else if(x===y){
      diagnostics.push({code:"anim.blendSpace.parameter.duplicate",message:`${label} uses "${x}" for both axes`,remediation:"Use distinct parameters for X and Y."});
    }
  }else{
    diagnostics.push({
      code:"anim.blendSpace.kind",
      message:`${label} has unknown kind "${String((space as {kind?:unknown}).kind)}"`,
      remediation:"Use kind \"1d\" or \"2d\".",
    });
    return diagnostics;
  }

  if(!Array.isArray(space.samples)){
    diagnostics.push({code:"anim.blendSpace.samples.invalid",message:`${label} samples must be an array`,remediation:"Set samples to an array of { clipId, position } entries."});
    return diagnostics;
  }
  if(space.samples.length===0){
    diagnostics.push({code:"anim.blendSpace.samples.empty",message:`${label} has no samples`,remediation:"Add at least one { clipId, position } sample."});
    return diagnostics;
  }

  const seenClips=new Set<string>();
  const points:Array<[number,number]>=[];
  for(const [index,rawSample] of space.samples.entries()){
    if(typeof rawSample!=="object" || rawSample===null){
      diagnostics.push({code:"anim.blendSpace.sample.invalid",message:`${label} sample ${index} is not an object`,remediation:"Use a { clipId, position } object for every sample."});
      continue;
    }
    const sample=rawSample;
    if(typeof sample.clipId!=="string" || sample.clipId.length===0){
      diagnostics.push({code:"anim.blendSpace.sample.clip.empty",message:`${label} sample ${index} has no clipId`,remediation:"Set clipId to an existing clip."});
    }else if(seenClips.has(sample.clipId)){
      diagnostics.push({code:"anim.blendSpace.sample.clip.duplicate",message:`${label} uses clip "${sample.clipId}" more than once`,remediation:"Use each clip at most once per blend space."});
    }
    seenClips.add(sample.clipId);

    let point:[number,number]|undefined;
    if(space.kind==="1d"){
      const position=(sample as BlendSpaceSample1D).position;
      if(isFiniteNumber(position)) point=[position,0];
    }else{
      const position=(sample as BlendSpaceSample2D).position;
      if(Array.isArray(position) && position.length===2 && isFiniteNumber(position[0]) && isFiniteNumber(position[1])){
        point=[position[0],position[1]];
      }
    }
    if(!point){
      diagnostics.push({
        code:"anim.blendSpace.sample.position.invalid",
        message:`${label} sample ${index} has an invalid position`,
        remediation:space.kind==="1d"?"Use a finite number.":"Use a [x, y] pair of finite numbers.",
      });
      continue;
    }
    for(const other of points){
      if(Math.hypot(point[0]-other[0],point[1]-other[1])<MIN_SAMPLE_SEPARATION){
        diagnostics.push({
          code:"anim.blendSpace.sample.position.duplicate",
          message:`${label} sample ${index} overlaps another sample at the same position`,
          remediation:"Move one of the samples; two clips cannot occupy the same point.",
        });
        break;
      }
    }
    points.push(point);
  }

  return diagnostics;
}

function assertValid(space:BlendSpaceDefinition):void{
  const diagnostics=validateBlendSpace(space);
  if(diagnostics.length>0){
    throw new Error(`Invalid blend space: ${diagnostics.map(d=>d.message).join("; ")}`);
  }
}

function normalize(raw:BlendSpaceWeight[]):BlendSpaceWeight[]{
  const kept=raw.filter(entry=>entry.weight>BLEND_SPACE_WEIGHT_EPSILON);
  const total=kept.reduce((sum,entry)=>sum+entry.weight,0);
  if(total<=0) return [];
  return kept
    .map(entry=>({clipId:entry.clipId,weight:entry.weight/total}))
    .sort((a,b)=>b.weight-a.weight || compareCodePoints(a.clipId,b.clipId));
}

/**
 * 1D weights: linear between the two neighbouring samples, clamped to the
 * outermost sample beyond the ends.
 */
export function evaluateBlendSpace1D(space:BlendSpace1DDefinition,value:number):BlendSpaceWeight[]{
  assertValid(space);
  if(!isFiniteNumber(value)) throw new TypeError(`Blend space "${space.id}" input must be a finite number`);

  const sorted=[...space.samples].sort((a,b)=>a.position-b.position);
  const first=sorted[0]!;
  const last=sorted[sorted.length-1]!;
  if(value<=first.position) return [{clipId:first.clipId,weight:1}];
  if(value>=last.position) return [{clipId:last.clipId,weight:1}];

  for(let i=0;i<sorted.length-1;i++){
    const a=sorted[i]!;
    const b=sorted[i+1]!;
    if(value>=a.position && value<=b.position){
      const t=(value-a.position)/(b.position-a.position);
      return normalize([{clipId:a.clipId,weight:1-t},{clipId:b.clipId,weight:t}]);
    }
  }
  return [{clipId:last.clipId,weight:1}];
}

/**
 * 2D weights via cartesian gradient band interpolation. Each sample's
 * influence is the minimum, over every other sample, of the projection of the
 * input onto the band between them. Influences are normalized to sum to 1.
 * Exactly on a sample, that sample gets weight 1.
 */
export function evaluateBlendSpace2D(space:BlendSpace2DDefinition,x:number,y:number):BlendSpaceWeight[]{
  assertValid(space);
  if(!isFiniteNumber(x) || !isFiniteNumber(y)) throw new TypeError(`Blend space "${space.id}" input must be finite numbers`);

  const samples=space.samples;
  if(samples.length===1) return [{clipId:samples[0]!.clipId,weight:1}];

  const raw:BlendSpaceWeight[]=[];
  for(let i=0;i<samples.length;i++){
    const [pix,piy]=samples[i]!.position;
    let influence=1;
    for(let j=0;j<samples.length;j++){
      if(i===j) continue;
      const [pjx,pjy]=samples[j]!.position;
      const ijx=pjx-pix;
      const ijy=pjy-piy;
      const lenSq=ijx*ijx+ijy*ijy;
      const ipx=x-pix;
      const ipy=y-piy;
      const h=1-(ipx*ijx+ipy*ijy)/lenSq;
      if(h<influence) influence=h;
      if(influence<=0) break;
    }
    raw.push({clipId:samples[i]!.clipId,weight:Math.max(0,influence)});
  }
  const weights=normalize(raw);
  if(weights.length>0) return weights;
  // Defensive: gradient band always leaves the extreme sample in the query
  // direction with positive influence, but if rounding ever zeroes every
  // influence, fall back to the nearest sample instead of returning no pose.
  let nearest=samples[0]!;
  let nearestDist=Number.POSITIVE_INFINITY;
  for(const sample of samples){
    const dist=Math.hypot(x-sample.position[0],y-sample.position[1]);
    if(dist<nearestDist || (dist===nearestDist && compareCodePoints(sample.clipId,nearest.clipId)<0)){
      nearest=sample;
      nearestDist=dist;
    }
  }
  return [{clipId:nearest.clipId,weight:1}];
}

/**
 * Evaluate any blend space against named parameter values (as returned by
 * `AnimationGraphMachine.getParameters()`). Missing or non-number parameters
 * throw, so a mis-wired graph fails loudly instead of silently idling.
 */
export function evaluateBlendSpace(space:BlendSpaceDefinition,parameters:Readonly<Record<string,boolean|number>>):BlendSpaceWeight[]{
  const read=(name:string):number=>{
    const value=parameters[name];
    if(typeof value!=="number"){
      throw new TypeError(`Blend space "${space.id}" parameter "${name}" must be a number, got ${value===undefined?"undefined":typeof value}`);
    }
    return value;
  };
  if(space.kind==="1d") return evaluateBlendSpace1D(space,read(space.parameter));
  return evaluateBlendSpace2D(space,read(space.parameters[0]),read(space.parameters[1]));
}
