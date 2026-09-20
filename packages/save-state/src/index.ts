export interface SaveEnvelope<T=unknown>{
  schemaVersion:number;
  gameVersion:string;
  slotId:string;
  savedAt:string;
  data:T;
}

export type SaveMigration=(data:unknown)=>unknown;

export class SaveMigrator {
  #migrations=new Map<number,SaveMigration>();

  constructor(readonly currentVersion:number){
    if(!Number.isInteger(currentVersion)||currentVersion<1) throw new Error("currentVersion must be >= 1");
  }

  register(fromVersion:number,migration:SaveMigration):this{
    if(fromVersion>=this.currentVersion) throw new Error("Migration source must be older than current version");
    if(this.#migrations.has(fromVersion)) throw new Error(`Migration from ${fromVersion} already registered`);
    this.#migrations.set(fromVersion,migration);
    return this;
  }

  migrate<T>(save:SaveEnvelope):SaveEnvelope<T>{
    if(save.schemaVersion>this.currentVersion) throw new Error("Save is newer than this game build");
    let version=save.schemaVersion;
    let data=structuredClone(save.data);

    while(version<this.currentVersion){
      const migration=this.#migrations.get(version);
      if(!migration) throw new Error(`Missing save migration from schema ${version}`);
      data=migration(data);
      version+=1;
    }

    return{...structuredClone(save),schemaVersion:this.currentVersion,data:data as T};
  }
}

export interface KeyValueStorage {
  get(key:string):Promise<string|undefined>;
  set(key:string,value:string):Promise<void>;
  delete(key:string):Promise<void>;
}

export class MemoryStorage implements KeyValueStorage {
  #values=new Map<string,string>();
  async get(key:string){return this.#values.get(key);}
  async set(key:string,value:string){this.#values.set(key,value);}
  async delete(key:string){this.#values.delete(key);}
}

export class JsonDocumentStore<T>{
  constructor(private readonly storage:KeyValueStorage,private readonly prefix:string){}

  async load(key:string):Promise<T|undefined>{
    const raw=await this.storage.get(`${this.prefix}:${key}`);
    return raw===undefined?undefined:JSON.parse(raw) as T;
  }

  async save(key:string,value:T):Promise<void>{
    await this.storage.set(`${this.prefix}:${key}`,JSON.stringify(value));
  }

  async remove(key:string):Promise<void>{
    await this.storage.delete(`${this.prefix}:${key}`);
  }
}

export interface EntitySaveState {
  position?: [number, number, number];
  rotation?: [number, number, number];
  gameplay?: Record<string, unknown>;
}

export interface GameplaySaveData {
  sceneId: string;
  entities: Record<string, EntitySaveState>;
}

export const CURRENT_SAVE_SCHEMA_VERSION = 2;

export function createGameplaySaveMigrator(): SaveMigrator {
  return new SaveMigrator(CURRENT_SAVE_SCHEMA_VERSION)
    .register(1, (data: unknown) => {
      const v1 = data as {
        sceneId: string;
        entities?: Record<string, {
          position?: [number, number, number];
          rotation?: [number, number, number];
          state?: Record<string, unknown>;
        }>;
      };

      const entities: Record<string, EntitySaveState> = {};
      for (const [entityId, entry] of Object.entries(v1.entities ?? {})) {
        entities[entityId] = {
          ...(entry.position !== undefined ? { position: entry.position } : {}),
          ...(entry.rotation !== undefined ? { rotation: entry.rotation } : {}),
          ...(entry.state !== undefined ? { gameplay: entry.state } : {}),
        };
      }

      return {
        sceneId: v1.sceneId,
        entities,
      };
    });
}

