export type SceneLifecycleState="unloaded"|"loading"|"loaded"|"active"|"paused"|"unloading";

export interface SceneLifecycleAdapter {
  load():Promise<void>;
  activate():Promise<void>;
  pause?():Promise<void>;
  resume?():Promise<void>;
  unload():Promise<void>;
}

/**
 * Serialized scene state machine. Exactly one adapter call may be in flight at a time:
 * a transition requested while another is pending is rejected instead of racing it
 * (e.g. an `unload()` issued during `activate()` would otherwise leave the scene
 * reported as "active" after it was unloaded). A failed adapter call leaves the
 * scene in the state it was in before the transition.
 */
export class SceneLifecycle {
  #state:SceneLifecycleState="unloaded";
  #pending:string|undefined;

  constructor(readonly sceneId:string,private readonly adapter:SceneLifecycleAdapter){}

  get state():SceneLifecycleState{return this.#state;}

  /** Name of the transition currently awaiting its adapter call, if any. */
  get pendingTransition():string|undefined{return this.#pending;}

  load():Promise<void>{
    return this.#transition("load",["unloaded"],"loading","loaded",()=>this.adapter.load());
  }

  activate():Promise<void>{
    return this.#transition("activate",["loaded"],undefined,"active",()=>this.adapter.activate());
  }

  pause():Promise<void>{
    return this.#transition("pause",["active"],undefined,"paused",async()=>{await this.adapter.pause?.();});
  }

  resume():Promise<void>{
    return this.#transition("resume",["paused"],undefined,"active",async()=>{await this.adapter.resume?.();});
  }

  unload():Promise<void>{
    return this.#transition("unload",["loaded","active","paused"],"unloading","unloaded",()=>this.adapter.unload());
  }

  async #transition(
    name:string,
    allowed:SceneLifecycleState[],
    during:SceneLifecycleState|undefined,
    after:SceneLifecycleState,
    run:()=>Promise<void>,
  ):Promise<void>{
    if(this.#pending!==undefined){
      throw new Error(`Scene "${this.sceneId}" cannot ${name}: transition "${this.#pending}" is still in progress`);
    }
    if(!allowed.includes(this.#state)){
      throw new Error(`Scene "${this.sceneId}" cannot transition from ${this.#state}; expected ${allowed.join(" or ")}`);
    }
    const before=this.#state;
    this.#pending=name;
    if(during) this.#state=during;
    try{
      await run();
      this.#state=after;
    }catch(error){
      this.#state=before;
      throw error;
    }finally{
      this.#pending=undefined;
    }
  }
}
