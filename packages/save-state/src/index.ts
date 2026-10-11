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
    if(!Number.isInteger(fromVersion)||fromVersion<1) throw new Error("Migration source version must be an integer >= 1");
    if(fromVersion>=this.currentVersion) throw new Error("Migration source must be older than current version");
    if(this.#migrations.has(fromVersion)) throw new Error(`Migration from ${fromVersion} already registered`);
    this.#migrations.set(fromVersion,migration);
    return this;
  }

  migrate<T>(save:SaveEnvelope):SaveEnvelope<T>{
    if(typeof save!=="object"||save===null||Array.isArray(save)) throw new Error("Save envelope must be an object");
    // A missing/NaN/fractional version used to slip past both comparisons below
    // and be returned as "current" with every migration skipped.
    if(!Number.isInteger(save.schemaVersion)||save.schemaVersion<1){
      throw new Error(`Save schemaVersion must be an integer >= 1 (got ${String(save.schemaVersion)})`);
    }
    if(save.schemaVersion>this.currentVersion) throw new Error("Save is newer than this game build");
    let version=save.schemaVersion;
    let data=structuredClone(save.data);

    while(version<this.currentVersion){
      const migration=this.#migrations.get(version);
      if(!migration) throw new Error(`Missing save migration from schema ${version}`);
      const migrated=migration(data);
      // A migration that mutates its input but forgets `return` would otherwise yield an
      // envelope whose data is undefined, which JSON.stringify drops: the slot loads back empty.
      if(migrated===undefined) throw new Error(`Save migration from schema ${version} returned undefined; a migration must return the migrated data`);
      data=migrated;
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

export interface PlatformStorageBridge {
  storageGet(key: string): Promise<string | undefined>;
  storageSet(key: string, value: string): Promise<void>;
  storageDelete(key: string): Promise<void>;
}

export class IpcKeyValueStorage implements KeyValueStorage {
  constructor(private readonly bridge: PlatformStorageBridge) {}

  async get(key: string): Promise<string | undefined> {
    return this.bridge.storageGet(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.bridge.storageSet(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.bridge.storageDelete(key);
  }
}

export class JsonDocumentStore<T>{
  constructor(private readonly storage:KeyValueStorage,private readonly prefix:string){}

  async load(key:string):Promise<T|undefined>{
    const raw=await this.storage.get(`${this.prefix}:${key}`);
    return raw===undefined?undefined:JSON.parse(raw) as T;
  }

  async save(key:string,value:T):Promise<void>{
    // JSON.stringify returns undefined (not a string) for undefined/function/symbol values;
    // storing that would corrupt the slot or fail later inside a storage backend.
    const serialized:string|undefined=JSON.stringify(value);
    if(typeof serialized!=="string") throw new TypeError(`JsonDocumentStore cannot serialize a ${typeof value} value for "${this.prefix}:${key}"`);
    await this.storage.set(`${this.prefix}:${key}`,serialized);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

export function createGameplaySaveMigrator(): SaveMigrator {
  return new SaveMigrator(CURRENT_SAVE_SCHEMA_VERSION)
    .register(1, (data: unknown) => {
      // Saves are untrusted JSON from disk: fail with a descriptive error instead of a TypeError.
      if (!isPlainRecord(data)) {
        throw new Error("Save migration v1→v2 received invalid data: expected an object");
      }
      const v1 = data as {
        sceneId: unknown;
        entities?: unknown;
      };
      // A save without a usable sceneId would migrate "successfully" and then lose the scene on the
      // next JSON round trip (undefined is dropped) or restore into a scene that does not exist.
      if (typeof v1.sceneId !== "string" || v1.sceneId.length === 0) {
        throw new Error(
          `Save migration v1→v2 received invalid data: sceneId must be a non-empty string (got ${JSON.stringify(v1.sceneId) ?? "undefined"})`,
        );
      }
      if (v1.entities !== undefined && !isPlainRecord(v1.entities)) {
        throw new Error("Save migration v1→v2 received invalid data: entities must be an object");
      }

      const entities: Record<string, EntitySaveState> = {};
      for (const [entityId, rawEntry] of Object.entries(v1.entities ?? {})) {
        if (!isPlainRecord(rawEntry)) {
          throw new Error(
            `Save migration v1→v2 received invalid data: entities["${entityId}"] must be an object`,
          );
        }
        const entry = rawEntry as {
          position?: unknown;
          rotation?: unknown;
          state?: unknown;
        };
        for (const field of ["position", "rotation"] as const) {
          const value = entry[field];
          if (value !== undefined && !isFiniteVec3(value)) {
            throw new Error(
              `Save migration v1→v2 received invalid data: entities["${entityId}"].${field} must be an array of 3 finite numbers`,
            );
          }
        }
        if (entry.state !== undefined && !isPlainRecord(entry.state)) {
          throw new Error(
            `Save migration v1→v2 received invalid data: entities["${entityId}"].state must be an object`,
          );
        }
        // defineProperty keeps an entity id such as "__proto__" as plain data;
        // plain assignment would swap the prototype and silently drop the entity.
        Object.defineProperty(entities, entityId, {
          value: {
            ...(entry.position !== undefined ? { position: entry.position as [number, number, number] } : {}),
            ...(entry.rotation !== undefined ? { rotation: entry.rotation as [number, number, number] } : {}),
            ...(entry.state !== undefined ? { gameplay: entry.state as Record<string, unknown> } : {}),
          } satisfies EntitySaveState,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      return {
        sceneId: v1.sceneId,
        entities,
      };
    });
}

export * from "./settings.js";
