export type InputBinding =
  | {kind:"key";code:string;scale?:number}
  | {kind:"gamepad-button";button:number;scale?:number}
  | {kind:"gamepad-axis";axis:number;scale?:number;deadzone?:number};

export interface InputActionDefinition {
  id:string;
  type:"button"|"axis";
  bindings:InputBinding[];
}

export interface InputMap {
  schemaVersion:1;
  actions:InputActionDefinition[];
}

export interface PhysicalInputSnapshot {
  keys:ReadonlySet<string>;
  gamepadButtons:readonly number[];
  gamepadAxes:readonly number[];
}

export class InputRouter {
  #map:InputMap;
  constructor(map:InputMap){this.#map=structuredClone(map);}

  remap(actionId:string,bindings:InputBinding[]):void{
    const action=this.#map.actions.find(candidate=>candidate.id===actionId);
    if(!action) throw new Error(`Unknown input action "${actionId}"`);
    action.bindings=structuredClone(bindings);
  }

  value(actionId:string,snapshot:PhysicalInputSnapshot):number{
    const action=this.#map.actions.find(candidate=>candidate.id===actionId);
    if(!action) throw new Error(`Unknown input action "${actionId}"`);

    let value=0;
    for(const binding of action.bindings){
      const scale=binding.scale??1;
      switch(binding.kind){
        case "key":
          if(snapshot.keys.has(binding.code)) value+=scale;
          break;
        case "gamepad-button":
          value+=(snapshot.gamepadButtons[binding.button]??0)*scale;
          break;
        case "gamepad-axis":{
          const raw=snapshot.gamepadAxes[binding.axis]??0;
          const deadzone=binding.deadzone??0.12;
          if(Math.abs(raw)>deadzone) value+=raw*scale;
          break;
        }
      }
    }

    value=Math.max(-1,Math.min(1,value));
    return action.type==="button"?(value>0.5?1:0):value;
  }

  exportMap():InputMap{return structuredClone(this.#map);}
}
