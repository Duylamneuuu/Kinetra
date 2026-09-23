import type {
  EntityDefinition,
  JsonObject,
  ProjectDocument,
  SceneDefinition,
} from "@kinetra/project-model";

export type ChangeKind = "created" | "updated" | "deleted";

export interface ChangeRecord {
  kind: ChangeKind;
  id: string;
  resource: "scene" | "entity" | "component" | "project";
}

export interface CommandBase {
  requestId: string;
  expectedProjectRevision?: number;
  transactionId?: string;
  dryRun?: boolean;
}

export interface SceneCreateCommand extends CommandBase {
  command: "scene.create";
  payload: { scene: SceneDefinition };
}

export interface EntityCreateCommand extends CommandBase {
  command: "entity.create";
  payload: { sceneId: string; entity: EntityDefinition };
}

export interface ComponentPatchCommand extends CommandBase {
  command: "component.patch";
  payload: { entityId: string; component: string; patch: JsonObject };
}

export interface EntityReparentCommand extends CommandBase {
  command: "entity.reparent";
  payload: { entityId: string; parentId?: string };
}

export interface EntityDeleteCommand extends CommandBase {
  command: "entity.delete";
  payload: { entityId: string; cascade?: boolean };
}

export type EngineCommand =
  | SceneCreateCommand
  | EntityCreateCommand
  | ComponentPatchCommand
  | EntityReparentCommand
  | EntityDeleteCommand;

export interface ExecuteOptions {
  expectedProjectRevision?: number;
  dryRun?: boolean;
}

export interface CommandResult {
  ok: true;
  revision: number;
  proposedRevision: number;
  changes: ChangeRecord[];
  warnings: string[];
  undoToken?: string;
}

export interface CommandEvent {
  id: string;
  operation: "execute" | "undo";
  revision: number;
  commands: EngineCommand[];
  changes: ChangeRecord[];
}

export interface EntityQuery {
  sceneId?: string;
  ids?: string[];
  component?: string;
  nameContains?: string;
  selectComponents?: string[];
  offset?: number;
  limit?: number;
}

export interface EntityQueryItem {
  sceneId: string;
  entity: EntityDefinition;
}

/** An entity id from the query that is not in the searched scenes. */
export interface EntityQueryEntityMiss {
  id: string;
  /** Scene that contains this entity when the query was limited to a different scene. */
  sceneId?: string;
}

/**
 * Caller-supplied ids that did not match.
 * Omitted when every supplied scene id and entity id matched.
 * `items` and `total` stay the matched page; misses are not copied into them.
 */
export interface EntityQueryUnmatched {
  /** Supplied scene id that is not in the project. Entity ids are not searched in this case. */
  sceneId?: string;
  availableSceneIds?: string[];
  omittedSceneCount?: number;
  entities?: EntityQueryEntityMiss[];
  omittedEntityCount?: number;
}

export interface EntityQueryResult {
  items: EntityQueryItem[];
  total: number;
  offset: number;
  limit: number;
  nextOffset?: number;
  unmatched?: EntityQueryUnmatched;
}

export interface CommandBusSnapshot {
  revision: number;
  project: ProjectDocument;
}
