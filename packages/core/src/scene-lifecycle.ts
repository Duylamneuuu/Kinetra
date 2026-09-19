export type SceneLifecycleState="unloaded"|"loading"|"loaded"|"active"|"paused"|"unloading";

export interface SceneLifecycleAdapter {
  load():Promise<void>;
  activate():Promise<void>;
  pause?():Promise<void>;
  resume?():Promise<void>;
  unload():Promise<void>;
}

export class SceneLifecycle {
  #state:SceneLifecycleState="unloaded";

  constructor(readonly sceneId:string,private readonly adapter:SceneLifecycleAdapter){}

  get state():SceneLifecycleState{return this.#state;}

  async load():Promise<void>{
    this.#require(["unloaded"]);
    this.#state="loading";
    try{
      await this.adapter.load();
      this.#state="loaded";
    }catch(error){
      this.#state="unloaded";
      throw error;
    }
  }

  async activate():Promise<void>{
    this.#require(["loaded"]);
    await this.adapter.activate();
    this.#state="active";
  }

  async pause():Promise<void>{
    this.#require(["active"]);
    await this.adapter.pause?.();
    this.#state="paused";
  }

  async resume():Promise<void>{
    this.#require(["paused"]);
    await this.adapter.resume?.();
    this.#state="active";
  }

  async unload():Promise<void>{
    this.#require(["loaded","active","paused"]);
    this.#state="unloading";
    try{
      await this.adapter.unload();
      this.#state="unloaded";
    }catch(error){
      this.#state="loaded";
      throw error;
    }
  }

  #require(allowed:SceneLifecycleState[]):void{
    if(!allowed.includes(this.#state)){
      throw new Error(`Scene "${this.sceneId}" cannot transition from ${this.#state}; expected ${allowed.join(" or ")}`);
    }
  }
}
