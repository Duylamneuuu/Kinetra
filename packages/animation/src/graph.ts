import {validateBlendSpace,type BlendSpaceDefinition} from "./blend-space.js";

export type AnimationParameterType="bool"|"number"|"trigger";

export interface AnimationParameterDefinition {
  type:AnimationParameterType;
  default?:boolean|number;
}

export interface AnimationStateDefinition {
  id:string;
  /** Clip played by this state. Exactly one of `clipId` / `blendSpaceId` is set. */
  clipId?:string;
  /**
   * Blend space (declared in `AnimationGraphDefinition.blendSpaces`) played by
   * this state. Its axes are graph number parameters of the same name, so the
   * graph parameter drives the blend every step.
   */
  blendSpaceId?:string;
  speed?:number;
  loop?:boolean;
}

export interface AnimationCondition {
  parameter:string;
  op:"=="|"!="|">"|">="|"<"|"<="|"triggered";
  value?:boolean|number;
}

export interface AnimationTransitionDefinition {
  id:string;
  from:string;
  to:string;
  conditions:AnimationCondition[];
  blendSeconds?:number;
  priority?:number;
}

export interface AnimationGraphDefinition {
  schemaVersion:1;
  entryState:string;
  parameters:Record<string,AnimationParameterDefinition>;
  states:AnimationStateDefinition[];
  transitions:AnimationTransitionDefinition[];
  /** Blend spaces that states may reference through `blendSpaceId`. */
  blendSpaces?:BlendSpaceDefinition[];
}

export interface AnimationGraphDiagnostic {
  code:string;
  message:string;
  remediation?:string;
}

const PARAMETER_TYPES:readonly AnimationParameterType[]=["bool","number","trigger"];
const CONDITION_OPS:readonly AnimationCondition["op"][]=["==","!=",">",">=","<","<=","triggered"];

/** Locale-independent ordering so transition choice never depends on the host's ICU/locale. */
function compareCodePoints(a:string,b:string):number{
  return a<b?-1:a>b?1:0;
}

function isFiniteNumber(value:unknown):value is number{
  return typeof value==="number" && Number.isFinite(value);
}

/** Own-property lookup: parameter names like "toString" must not resolve to Object.prototype members. */
function parameterDefinition(graph:AnimationGraphDefinition,name:string):AnimationParameterDefinition|undefined{
  return Object.hasOwn(graph.parameters,name)?graph.parameters[name]:undefined;
}

/** Graph parameters that drive a blend space, in axis order. */
export function blendSpaceAxes(space:BlendSpaceDefinition):string[]{
  return space.kind==="1d"?[space.parameter]:[space.parameters[0],space.parameters[1]];
}

export function validateAnimationGraph(graph:AnimationGraphDefinition):AnimationGraphDiagnostic[]{
  const diagnostics:AnimationGraphDiagnostic[]=[];
  const states=new Set<string>();

  for(const [name,definition] of Object.entries(graph.parameters)){
    if(!PARAMETER_TYPES.includes(definition?.type)){
      diagnostics.push({code:"anim.parameter.type",message:`Parameter "${name}" has unknown type "${String(definition?.type)}"`});
      continue;
    }
    if(definition.default===undefined) continue;
    const ok=definition.type==="bool"?typeof definition.default==="boolean"
      :definition.type==="number"?isFiniteNumber(definition.default)
      :false;
    if(!ok){
      diagnostics.push({code:"anim.parameter.default.type",message:`Parameter "${name}" (${definition.type}) has invalid default ${String(definition.default)}`});
    }
  }

  const blendSpaces=new Map<string,BlendSpaceDefinition>();
  if(graph.blendSpaces!==undefined && !Array.isArray(graph.blendSpaces)){
    diagnostics.push({code:"anim.graph.blendSpaces.type",message:"graph.blendSpaces must be an array",remediation:"Provide an array of blend-space definitions."});
  }else{
    for(const space of graph.blendSpaces??[]){
      const spaceDiagnostics=validateBlendSpace(space);
      for(const d of spaceDiagnostics) diagnostics.push({code:d.code,message:d.message,remediation:d.remediation});
      if(spaceDiagnostics.length>0 || typeof space.id!=="string") continue;
      if(blendSpaces.has(space.id)){
        diagnostics.push({code:"anim.blendSpace.duplicate",message:`Duplicate blend space "${space.id}"`,remediation:"Give every blend space a unique id."});
        continue;
      }
      blendSpaces.set(space.id,space);
    }
  }

  for(const state of graph.states){
    if(states.has(state.id)){
      diagnostics.push({code:"anim.state.duplicate",message:`Duplicate state "${state.id}"`});
    }
    states.add(state.id);
    const hasClip=typeof state.clipId==="string" && state.clipId.length>0;
    const hasSpace=state.blendSpaceId!==undefined;
    if(hasClip && hasSpace){
      diagnostics.push({
        code:"anim.state.clipAndBlendSpace",
        message:`State "${state.id}" sets both clipId and blendSpaceId`,
        remediation:"Give a state either a clipId or a blendSpaceId, not both.",
      });
    }else if(hasSpace){
      if(typeof state.blendSpaceId!=="string" || state.blendSpaceId.length===0){
        diagnostics.push({
          code:"anim.state.blendSpace.empty",
          message:`State "${state.id}" has an empty blendSpaceId`,
          remediation:"Name a blend space declared in graph.blendSpaces.",
        });
      }else{
        const space=blendSpaces.get(state.blendSpaceId);
        if(!space){
          diagnostics.push({
            code:"anim.state.blendSpace.unknown",
            message:`State "${state.id}" references unknown blend space "${state.blendSpaceId}"`,
            remediation:"Declare the blend space in graph.blendSpaces or fix the id.",
          });
        }else{
          for(const axis of blendSpaceAxes(space)){
            const parameter=parameterDefinition(graph,axis);
            if(parameter?.type!=="number"){
              diagnostics.push({
                code:"anim.state.blendSpace.parameter",
                message:`State "${state.id}" blend space "${state.blendSpaceId}" is driven by "${axis}", which is ${parameter?`a ${parameter.type} parameter`:"not a graph parameter"}`,
                remediation:`Declare "${axis}" as a number parameter in graph.parameters.`,
              });
            }
          }
        }
      }
    }else if(!hasClip){
      diagnostics.push({code:"anim.state.clip.empty",message:`State "${state.id}" has no clipId`,remediation:"Set clipId, or blendSpaceId to play a blend space."});
    }
    if(state.speed!==undefined && !isFiniteNumber(state.speed)){
      diagnostics.push({code:"anim.state.speed.invalid",message:`State "${state.id}" has non-finite speed`});
    }
  }

  if(!states.has(graph.entryState)){
    diagnostics.push({code:"anim.entry.missing",message:`Entry state "${graph.entryState}" does not exist`});
  }

  for(const transition of graph.transitions){
    if(transition.from !== "*" && !states.has(transition.from)){
      diagnostics.push({code:"anim.transition.from.missing",message:`Transition "${transition.id}" source is missing`});
    }
    if(!states.has(transition.to)){
      diagnostics.push({code:"anim.transition.to.missing",message:`Transition "${transition.id}" target is missing`});
    }
    if(transition.blendSeconds!==undefined && (typeof transition.blendSeconds!=="number" || !Number.isFinite(transition.blendSeconds) || transition.blendSeconds<0)){
      diagnostics.push({code:"anim.transition.blendSeconds.invalid",message:`Transition "${transition.id}" has invalid blendSeconds`});
    }
    if(transition.priority!==undefined && !isFiniteNumber(transition.priority)){
      diagnostics.push({code:"anim.transition.priority.invalid",message:`Transition "${transition.id}" has non-finite priority`});
    }
    for(const condition of transition.conditions){
      if(!CONDITION_OPS.includes(condition.op)){
        diagnostics.push({code:"anim.condition.op.invalid",message:`Transition "${transition.id}" uses unknown operator "${String(condition.op)}"`});
        continue;
      }
      const parameter=parameterDefinition(graph,condition.parameter);
      if(!parameter){
        diagnostics.push({code:"anim.condition.parameter.missing",message:`Condition parameter "${condition.parameter}" is missing`});
      }else if(condition.op==="triggered"){
        if(parameter.type!=="trigger"){
          diagnostics.push({code:"anim.condition.trigger.type",message:`Parameter "${condition.parameter}" is not a trigger`});
        }
      }else{
        const numericOp=condition.op!=="==" && condition.op!=="!=";
        const ok=parameter.type==="number"?isFiniteNumber(condition.value)
          :parameter.type==="bool"?!numericOp && typeof condition.value==="boolean"
          :false;
        if(!ok){
          diagnostics.push({
            code:"anim.condition.value.type",
            message:`Transition "${transition.id}" compares ${parameter.type} parameter "${condition.parameter}" with ${condition.op} ${String(condition.value)}`,
          });
        }
      }
    }
  }

  return diagnostics;
}

export interface AnimationTransitionResult {
  from:string;
  to:string;
  transitionId:string;
  blendSeconds:number;
}

export class AnimationGraphMachine {
  readonly graph:AnimationGraphDefinition;
  #state:string;
  #values=new Map<string,boolean|number>();
  #triggers=new Set<string>();

  constructor(graph:AnimationGraphDefinition){
    const diagnostics=validateAnimationGraph(graph);
    if(diagnostics.length>0){
      throw new Error(`Invalid animation graph: ${diagnostics.map(d=>d.message).join("; ")}`);
    }
    this.graph=structuredClone(graph);
    this.#state=graph.entryState;

    for(const [name,definition] of Object.entries(graph.parameters)){
      if(definition.type==="trigger") continue;
      if(definition.default!==undefined){
        this.#values.set(name,definition.default);
      }else{
        this.#values.set(name,definition.type==="bool"?false:0);
      }
    }
  }

  get state():string{return this.#state;}

  getStateDefinition(stateId: string = this.#state): AnimationStateDefinition | undefined {
    return this.graph.states.find((s) => s.id === stateId);
  }

  get currentStateDefinition(): AnimationStateDefinition | undefined {
    return this.getStateDefinition(this.#state);
  }

  /** Blend space a state plays, if it plays one. */
  getBlendSpace(stateId: string = this.#state): BlendSpaceDefinition | undefined {
    const id = this.getStateDefinition(stateId)?.blendSpaceId;
    if (id === undefined) return undefined;
    return this.graph.blendSpaces?.find((space) => space.id === id);
  }

  /**
   * Current graph parameter values for the axes of a blend-space state, keyed
   * by axis name. `undefined` when the state does not play a blend space.
   */
  getBlendSpaceInput(stateId: string = this.#state): Record<string, number> | undefined {
    const space = this.getBlendSpace(stateId);
    if (!space) return undefined;
    const input: Record<string, number> = {};
    for (const axis of blendSpaceAxes(space)) {
      const value = this.#values.get(axis);
      input[axis] = typeof value === "number" ? value : 0;
    }
    return input;
  }

  getParameter(name: string): boolean | number | undefined {
    return this.#values.get(name);
  }

  getParameters(): Record<string, boolean | number> {
    const result: Record<string, boolean | number> = {};
    for (const [key, value] of this.#values) {
      result[key] = value;
    }
    return result;
  }

  get triggers(): string[] {
    return Array.from(this.#triggers);
  }

  hasTrigger(name: string): boolean {
    return this.#triggers.has(name);
  }

  reset(entryState?: string): void {
    if (entryState) {
      if (!this.graph.states.some((s) => s.id === entryState)) {
        throw new Error(`Unknown entry state "${entryState}"`);
      }
      this.#state = entryState;
    } else {
      this.#state = this.graph.entryState;
    }
    this.#triggers.clear();
    for (const [name, definition] of Object.entries(this.graph.parameters)) {
      if (definition.type === "trigger") continue;
      if (definition.default !== undefined) {
        this.#values.set(name, definition.default);
      } else {
        this.#values.set(name, definition.type === "bool" ? false : 0);
      }
    }
  }

  set(name:string,value:boolean|number):void{
    const definition=parameterDefinition(this.graph,name);
    if(!definition) throw new Error(`Unknown animation parameter "${name}"`);
    if(definition.type==="trigger") throw new Error(`Trigger "${name}" must use trigger()`);
    if(definition.type==="bool" && typeof value!=="boolean") throw new TypeError(`Parameter "${name}" expects boolean`);
    if(definition.type==="number" && !isFiniteNumber(value)) throw new TypeError(`Parameter "${name}" expects a finite number`);
    this.#values.set(name,value);
  }

  trigger(name:string):void{
    const definition=parameterDefinition(this.graph,name);
    if(!definition || definition.type!=="trigger") throw new Error(`Unknown trigger "${name}"`);
    this.#triggers.add(name);
  }

  evaluate():AnimationTransitionResult|undefined{
    const candidates=this.graph.transitions
      .filter(t=> (t.from===this.#state || t.from==="*") && t.to !== this.#state)
      .sort((a,b)=>(b.priority??0)-(a.priority??0) || compareCodePoints(a.id,b.id));

    for(const transition of candidates){
      if(transition.conditions.every(condition=>this.#matches(condition))){
        const from=this.#state;
        this.#state=transition.to;
        for(const condition of transition.conditions){
          if(condition.op==="triggered") this.#triggers.delete(condition.parameter);
        }
        return{
          from,to:transition.to,transitionId:transition.id,
          blendSeconds:transition.blendSeconds??0.15,
        };
      }
    }
    return undefined;
  }

  #matches(condition:AnimationCondition):boolean{
    const definition=parameterDefinition(this.graph,condition.parameter);
    if(!definition) return false;
    if(condition.op==="triggered") return this.#triggers.has(condition.parameter);

    const actual=this.#values.get(condition.parameter);
    const expected=condition.value;
    switch(condition.op){
      case "==":return actual===expected;
      case "!=":return actual!==expected;
      case ">":return typeof actual==="number"&&typeof expected==="number"&&actual>expected;
      case ">=":return typeof actual==="number"&&typeof expected==="number"&&actual>=expected;
      case "<":return typeof actual==="number"&&typeof expected==="number"&&actual<expected;
      case "<=":return typeof actual==="number"&&typeof expected==="number"&&actual<=expected;
    }
  }
}
