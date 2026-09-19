export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ComponentMap = Record<string, JsonValue>;

export interface EntityDefinition {
  id: string;
  name: string;
  parentId?: string;
  components: ComponentMap;
}

export interface SceneDefinition {
  id: string;
  name: string;
  entities: EntityDefinition[];
}

export interface ProjectDocumentV1 {
  schemaVersion: 1;
  projectId: string;
  name: string;
  scenes: SceneDefinition[];
  metadata?: JsonObject;
}

export type ProjectDocument = ProjectDocumentV1;

export interface LegacyEntityV0 {
  id: string;
  name: string;
  parent?: string;
  components?: ComponentMap;
}

export interface LegacySceneV0 {
  id: string;
  name: string;
  objects?: LegacyEntityV0[];
}

export interface ProjectDocumentV0 {
  schemaVersion: 0;
  id: string;
  name: string;
  scenes?: LegacySceneV0[];
}
