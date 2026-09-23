export type AnimationParameterType="bool"|"number"|"trigger";

export interface AnimationParameterDefinition {
  type:AnimationParameterType;
  default?:boolean|number;
}

export interface AnimationStateDefinition {
  id:string;
  clipId:string;
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
}

export interface AnimationGraphDiagnostic {
  code:string;
  message:string;
}

const ANIMATION_ID_LIST_LIMIT=12;

function describeAnimationChoices(label:string, ids:readonly string[]):string{
  const sorted=[...new Set(ids.filter((id)=>id.length>0))].sort();
  if(sorted.length===0) return `${label}: (none).`;
  const shown=sorted.slice(0,ANIMATION_ID_LIST_LIMIT);
  const hidden=sorted.length-shown.length;
  const extra=hidden>0?`, and ${hidden} more`:"";
  return `${label}: ${shown.join(", ")}${extra}.`;
}

export function validateAnimationGraph(graph:AnimationGraphDefinition):AnimationGraphDiagnostic[]{
  const diagnostics:AnimationGraphDiagnostic[]=[];
  const states=new Set<string>();

  for(const state of graph.states){
    if(states.has(state.id)){
      diagnostics.push({code:"anim.state.duplicate",message:`Duplicate state "${state.id}"`});
    }
    states.add(state.id);
    if(!state.clipId){
      diagnostics.push({code:"anim.state.clip.empty",message:`State "${state.id}" has no clipId`});
    }
  }

  const stateIds=[...states];
  if(!states.has(graph.entryState)){
    diagnostics.push({
      code:"anim.entry.missing",
      message:`Entry state "${graph.entryState}" does not exist. ${describeAnimationChoices("Available states",stateIds)}`,
    });
  }

  const triggerIds=Object.entries(graph.parameters)
    .filter(([,definition])=>definition.type==="trigger")
    .map(([name])=>name);

  for(const transition of graph.transitions){
    if(!states.has(transition.from)){
      diagnostics.push({
        code:"anim.transition.from.missing",
        message:`Transition "${transition.id}" source "${transition.from}" does not exist. ${describeAnimationChoices("Available states",stateIds)}`,
      });
    }
    if(!states.has(transition.to)){
      diagnostics.push({
        code:"anim.transition.to.missing",
        message:`Transition "${transition.id}" target "${transition.to}" does not exist. ${describeAnimationChoices("Available states",stateIds)}`,
      });
    }
    for(const condition of transition.conditions){
      const parameter=graph.parameters[condition.parameter];
      if(!parameter){
        diagnostics.push({
          code:"anim.condition.parameter.missing",
          message:`Condition parameter "${condition.parameter}" is missing. ${describeAnimationChoices("Available parameters",Object.keys(graph.parameters))}`,
        });
      }else if(condition.op==="triggered" && parameter.type!=="trigger"){
        diagnostics.push({
          code:"anim.condition.trigger.type",
          message:`Parameter "${condition.parameter}" is not a trigger. ${describeAnimationChoices("Trigger parameters",triggerIds)}`,
        });
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

  set(name:string,value:boolean|number):void{
    const definition=this.graph.parameters[name];
    if(!definition) throw new Error(`Unknown animation parameter "${name}"`);
    if(definition.type==="trigger") throw new Error(`Trigger "${name}" must use trigger()`);
    if(definition.type==="bool" && typeof value!=="boolean") throw new TypeError(`Parameter "${name}" expects boolean`);
    if(definition.type==="number" && typeof value!=="number") throw new TypeError(`Parameter "${name}" expects number`);
    this.#values.set(name,value);
  }

  trigger(name:string):void{
    const definition=this.graph.parameters[name];
    if(!definition || definition.type!=="trigger") throw new Error(`Unknown trigger "${name}"`);
    this.#triggers.add(name);
  }

  evaluate():AnimationTransitionResult|undefined{
    const candidates=this.graph.transitions
      .filter(t=>t.from===this.#state)
      .sort((a,b)=>(b.priority??0)-(a.priority??0) || a.id.localeCompare(b.id));

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
    const definition=this.graph.parameters[condition.parameter];
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
