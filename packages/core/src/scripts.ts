export interface GameScriptContext {
  readonly entityId:string;
  readonly sceneId:string;
}

export interface GameScript {
  onCreate?(context:GameScriptContext):void|Promise<void>;
  onStart?(context:GameScriptContext):void|Promise<void>;
  onUpdate?(context:GameScriptContext,deltaSeconds:number):void;
  onStop?(context:GameScriptContext):void|Promise<void>;
  onDestroy?(context:GameScriptContext):void|Promise<void>;
}

interface ScriptEntry {
  id:string;
  order:number;
  context:GameScriptContext;
  script:GameScript;
  created:boolean;
  started:boolean;
}

export class ScriptHost {
  #entries=new Map<string,ScriptEntry>();

  register(input:{
    id:string;
    order?:number;
    context:GameScriptContext;
    script:GameScript;
  }):void{
    if(this.#entries.has(input.id)) throw new Error(`Script "${input.id}" already registered`);
    this.#entries.set(input.id,{
      id:input.id,order:input.order??0,context:input.context,script:input.script,
      created:false,started:false,
    });
  }

  async startAll():Promise<void>{
    for(const entry of this.#ordered()){
      if(!entry.created){
        await entry.script.onCreate?.(entry.context);
        entry.created=true;
      }
      if(!entry.started){
        await entry.script.onStart?.(entry.context);
        entry.started=true;
      }
    }
  }

  update(deltaSeconds:number):void{
    if(!Number.isFinite(deltaSeconds)||deltaSeconds<0) throw new RangeError("deltaSeconds must be finite and non-negative");
    for(const entry of this.#ordered()){
      if(entry.started) entry.script.onUpdate?.(entry.context,deltaSeconds);
    }
  }

  async stopAll():Promise<void>{
    for(const entry of this.#ordered().reverse()){
      if(entry.started){
        await entry.script.onStop?.(entry.context);
        entry.started=false;
      }
    }
  }

  async destroyAll():Promise<void>{
    await this.stopAll();
    for(const entry of this.#ordered().reverse()){
      if(entry.created){
        await entry.script.onDestroy?.(entry.context);
        entry.created=false;
      }
    }
    this.#entries.clear();
  }

  #ordered():ScriptEntry[]{
    return [...this.#entries.values()].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
  }
}
