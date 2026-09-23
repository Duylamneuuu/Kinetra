import { stableId, type ComponentMap, type EntityDefinition, type JsonObject } from "@kinetra/project-model";

export interface PrefabEntityTemplate {
  localId:string;
  name:string;
  parentLocalId?:string;
  components:ComponentMap;
}

export interface PrefabDefinition {
  id:string;
  name:string;
  entities:PrefabEntityTemplate[];
}

export interface PrefabOverride {
  localId:string;
  component:string;
  patch:JsonObject;
}

function jsonObject(value:unknown):value is JsonObject{
  return typeof value==="object"&&value!==null&&!Array.isArray(value);
}

export function instantiatePrefab(input:{
  prefab:PrefabDefinition;
  instanceId:string;
  overrides?:PrefabOverride[];
}):EntityDefinition[]{
  const localIds=new Set(input.prefab.entities.map(entity=>entity.localId));
  if(localIds.size!==input.prefab.entities.length){
    const seen=new Set<string>();
    const duplicates:string[]=[];
    for(const entity of input.prefab.entities){
      if(seen.has(entity.localId)) duplicates.push(entity.localId);
      else seen.add(entity.localId);
    }
    const unique=[...new Set(duplicates)].sort().slice(0,12);
    throw new Error(`Prefab local IDs must be unique. Duplicates: ${unique.join(", ")}.`);
  }

  for(const entity of input.prefab.entities){
    if(entity.parentLocalId&&!localIds.has(entity.parentLocalId)){
      throw new Error(describePrefabLocalIds(
        `Prefab parent "${entity.parentLocalId}" does not exist`,
        [...localIds],
      ));
    }
  }

  const idFor=(localId:string)=>stableId("entity",`${input.prefab.id}:${input.instanceId}:${localId}`);
  const result=input.prefab.entities.map(template=>({
    id:idFor(template.localId),
    name:template.name,
    ...(template.parentLocalId?{parentId:idFor(template.parentLocalId)}:{}),
    components:structuredClone(template.components),
  }));

  const byLocal=new Map(input.prefab.entities.map((template,index)=>[template.localId,result[index]!]));

  for(const override of input.overrides??[]){
    const entity=byLocal.get(override.localId);
    if(!entity){
      throw new Error(describePrefabLocalIds(
        `Override targets unknown prefab entity "${override.localId}"`,
        [...localIds],
      ));
    }
    const existing=entity.components[override.component];
    if(existing!==undefined&&!jsonObject(existing)){
      throw new Error(`Component "${override.component}" is not object data and cannot be patched`);
    }
    entity.components[override.component]={
      ...(jsonObject(existing)?existing:{}),
      ...structuredClone(override.patch),
    };
  }

  return result;
}

const PREFAB_LOCAL_ID_LIMIT=12;

function describePrefabLocalIds(prefix:string,ids:readonly string[]):string{
  const sorted=[...new Set(ids.filter((id)=>id.length>0))].sort();
  if(sorted.length===0) return `${prefix}. Available local ids: (none).`;
  const shown=sorted.slice(0,PREFAB_LOCAL_ID_LIMIT);
  const hidden=sorted.length-shown.length;
  const extra=hidden>0?`, and ${hidden} more`:"";
  return `${prefix}. Available local ids: ${shown.join(", ")}${extra}.`;
}
