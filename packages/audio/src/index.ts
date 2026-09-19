export interface AudioBusDefinition {
  id:string;
  parentId?:string;
  gain:number;
  muted?:boolean;
}

export class AudioMixerModel {
  #buses=new Map<string,AudioBusDefinition>();

  constructor(buses:AudioBusDefinition[]){
    for(const bus of buses){
      if(this.#buses.has(bus.id)) throw new Error(`Duplicate audio bus "${bus.id}"`);
      this.#buses.set(bus.id,structuredClone(bus));
    }
    for(const bus of this.#buses.values()){
      if(bus.parentId&&!this.#buses.has(bus.parentId)) throw new Error(`Audio bus parent "${bus.parentId}" missing`);
    }
    for(const id of this.#buses.keys()) this.#assertNoCycle(id);
  }

  setGain(id:string,gain:number):void{
    if(!Number.isFinite(gain)||gain<0) throw new RangeError("gain must be finite and >= 0");
    this.#require(id).gain=gain;
  }

  setMuted(id:string,muted:boolean):void{this.#require(id).muted=muted;}

  effectiveGain(id:string):number{
    let gain=1;
    let current:AudioBusDefinition|undefined=this.#require(id);
    const visited=new Set<string>();

    while(current){
      if(visited.has(current.id)) throw new Error("Audio bus cycle detected");
      visited.add(current.id);
      if(current.muted) return 0;
      gain*=current.gain;
      current=current.parentId?this.#buses.get(current.parentId):undefined;
    }
    return gain;
  }

  #require(id:string):AudioBusDefinition{
    const bus=this.#buses.get(id);
    if(!bus) throw new Error(`Unknown audio bus "${id}"`);
    return bus;
  }

  #assertNoCycle(id:string):void{
    const visited=new Set<string>();
    let current:AudioBusDefinition|undefined=this.#buses.get(id);
    while(current){
      if(visited.has(current.id)) throw new Error("Audio bus cycle detected");
      visited.add(current.id);
      current=current.parentId?this.#buses.get(current.parentId):undefined;
    }
  }
}
