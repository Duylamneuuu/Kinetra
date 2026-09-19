import { stableId, type ComponentMap, type EntityDefinition } from "@kinetra/project-model";

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
  patch:Record<string,unknown>;
}

function jsonObject(value:unknown):value is Record<string,unknown>{
  return typeof value==="object"&&value!==null&&!Array.isArray(value);
}

export function instantiatePrefab(input:{
  prefab:PrefabDefinition;
  instanceId:string;
  overrides?:PrefabOverride[];
}):EntityDefinition[]{
  const localIds=new Set(input.prefab.entities.map(entity=>entity.localId));
  if(localIds.size!==input.prefab.entities.length) throw new Error("Prefab local IDs must be unique");

  for(const entity of input.prefab.entities){
    if(entity.parentLocalId&&!localIds.has(entity.parentLocalId)){
      throw new Error(`Prefab parent "${entity.parentLocalId}" does not exist`);
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
    if(!entity) throw new Error(`Override targets unknown prefab entity "${override.localId}"`);
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
