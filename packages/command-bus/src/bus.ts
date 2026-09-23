import {
  assertValidProject,
  cloneProject,
  type EntityDefinition,
  type JsonObject,
  type JsonValue,
  type ProjectDocument,
  type SceneDefinition,
} from "@kinetra/project-model";

import { CommandError } from "./errors.js";
import { parseEngineCommand } from "./validation.js";
import type {
  ChangeRecord,
  CommandBusSnapshot,
  CommandEvent,
  CommandResult,
  EngineCommand,
  EntityQuery,
  EntityQueryItem,
  EntityQueryResult,
  ExecuteOptions,
} from "./types.js";

interface LocatedEntity {
  scene: SceneDefinition;
  entity: EntityDefinition;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findEntity(project: ProjectDocument, entityId: string): LocatedEntity | undefined {
  for (const scene of project.scenes) {
    const entity = scene.entities.find((candidate) => candidate.id === entityId);
    if (entity) {
      return { scene, entity };
    }
  }
  return undefined;
}

function assertRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new CommandError(
      "STALE_REVISION",
      `Expected project revision ${expected}, current revision is ${actual}`,
    );
  }
}

function collectDescendants(scene: SceneDefinition, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const entity of scene.entities) {
      if (entity.parentId && ids.has(entity.parentId) && !ids.has(entity.id)) {
        ids.add(entity.id);
        changed = true;
      }
    }
  }

  return ids;
}

const MISSING_ID_LIST_LIMIT = 12;

function formatIdList(ids: readonly string[]): string {
  const sorted = [...new Set(ids.filter((id) => id.length > 0))].sort();
  const shown = sorted.slice(0, MISSING_ID_LIST_LIMIT);
  const hidden = sorted.length - shown.length;
  const extra = hidden > 0 ? `, and ${hidden} more` : "";
  return shown.length === 0 ? "" : `${shown.join(", ")}${extra}`;
}

function describeMissingScene(
  sceneId: string,
  project: ProjectDocument,
): { message: string; remediation: string } {
  const listed = formatIdList(project.scenes.map((scene) => scene.id));
  if (!listed) {
    return {
      message: `Scene "${sceneId}" does not exist. No scenes are in the project.`,
      remediation: "Call scene.create to add a scene, then retry with that scene id.",
    };
  }
  return {
    message: `Scene "${sceneId}" does not exist. Available scenes: ${listed}.`,
    remediation: `Retry with one of: ${listed}. Call scene.query to refresh.`,
  };
}

function describeMissingEntity(
  entityId: string,
  project: ProjectDocument,
): { message: string; remediation: string } {
  const listed = formatIdList(
    project.scenes.flatMap((scene) => scene.entities.map((entity) => entity.id)),
  );
  if (!listed) {
    return {
      message: `Entity "${entityId}" does not exist. No entities are in the project.`,
      remediation: "Call entity.create to add an entity, then retry with that entity id.",
    };
  }
  return {
    message: `Entity "${entityId}" does not exist. Available entities: ${listed}.`,
    remediation: `Retry with one of: ${listed}. Call entity.query to refresh.`,
  };
}

function describeMissingParent(
  parentId: string,
  scene: SceneDefinition,
  where: string,
): { message: string; remediation: string } {
  const listed = formatIdList(scene.entities.map((entity) => entity.id));
  const available = listed
    ? ` Available entities: ${listed}.`
    : " No entities are in this scene.";
  return {
    message: `Parent "${parentId}" does not exist ${where}.${available}`,
    remediation: listed
      ? `Retry with one of: ${listed}. Call entity.query to refresh.`
      : "Create an entity in this scene, or omit parentId.",
  };
}

function applyCommand(project: ProjectDocument, command: EngineCommand): ChangeRecord[] {
  switch (command.command) {
    case "scene.create": {
      const scene = structuredClone(command.payload.scene);
      if (project.scenes.some((candidate) => candidate.id === scene.id)) {
        throw new CommandError("SCENE_ALREADY_EXISTS", `Scene "${scene.id}" already exists`);
      }
      project.scenes.push(scene);
      return [{ kind: "created", id: scene.id, resource: "scene" }];
    }

    case "entity.create": {
      const scene = project.scenes.find((candidate) => candidate.id === command.payload.sceneId);
      if (!scene) {
        const described = describeMissingScene(command.payload.sceneId, project);
        throw new CommandError("SCENE_NOT_FOUND", described.message, described.remediation);
      }

      if (findEntity(project, command.payload.entity.id)) {
        throw new CommandError(
          "ENTITY_ALREADY_EXISTS",
          `Entity "${command.payload.entity.id}" already exists`,
        );
      }

      if (
        command.payload.entity.parentId &&
        !scene.entities.some((entity) => entity.id === command.payload.entity.parentId)
      ) {
        const described = describeMissingParent(
          command.payload.entity.parentId,
          scene,
          `in scene "${scene.id}"`,
        );
        throw new CommandError("PARENT_NOT_FOUND", described.message, described.remediation);
      }

      scene.entities.push(structuredClone(command.payload.entity));
      return [{ kind: "created", id: command.payload.entity.id, resource: "entity" }];
    }

    case "component.patch": {
      const located = findEntity(project, command.payload.entityId);
      if (!located) {
        const described = describeMissingEntity(command.payload.entityId, project);
        throw new CommandError("ENTITY_NOT_FOUND", described.message, described.remediation);
      }

      const existing = located.entity.components[command.payload.component];
      if (existing !== undefined && !isJsonObject(existing)) {
        throw new CommandError(
          "COMPONENT_NOT_OBJECT",
          `Component "${command.payload.component}" is not patchable object data`,
        );
      }

      located.entity.components[command.payload.component] = {
        ...(existing ?? {}),
        ...structuredClone(command.payload.patch),
      };

      return [
        {
          kind: "updated",
          id: located.entity.id,
          resource: "component",
        },
      ];
    }

    case "entity.reparent": {
      const located = findEntity(project, command.payload.entityId);
      if (!located) {
        const described = describeMissingEntity(command.payload.entityId, project);
        throw new CommandError("ENTITY_NOT_FOUND", described.message, described.remediation);
      }

      if (command.payload.parentId) {
        const parent = located.scene.entities.find(
          (candidate) => candidate.id === command.payload.parentId,
        );
        if (!parent) {
          const described = describeMissingParent(
            command.payload.parentId,
            located.scene,
            "in the same scene",
          );
          throw new CommandError("PARENT_NOT_FOUND", described.message, described.remediation);
        }
        located.entity.parentId = parent.id;
      } else {
        delete located.entity.parentId;
      }

      return [{ kind: "updated", id: located.entity.id, resource: "entity" }];
    }

    case "entity.delete": {
      const located = findEntity(project, command.payload.entityId);
      if (!located) {
        const described = describeMissingEntity(command.payload.entityId, project);
        throw new CommandError("ENTITY_NOT_FOUND", described.message, described.remediation);
      }

      const directChildren = located.scene.entities.filter(
        (entity) => entity.parentId === located.entity.id,
      );

      if (directChildren.length > 0 && command.payload.cascade !== true) {
        const listed = formatIdList(directChildren.map((entity) => entity.id));
        throw new CommandError(
          "CHILDREN_EXIST",
          `Entity "${located.entity.id}" has children; set cascade=true to delete the subtree. Child ids: ${listed}.`,
          `Reparent or delete ${listed}, or retry entity.delete with cascade=true.`,
        );
      }

      const deletedIds =
        command.payload.cascade === true
          ? collectDescendants(located.scene, located.entity.id)
          : new Set([located.entity.id]);

      located.scene.entities = located.scene.entities.filter((entity) => !deletedIds.has(entity.id));

      return [...deletedIds].map((id) => ({ kind: "deleted" as const, id, resource: "entity" as const }));
    }

    default: {
      const exhaustive: never = command;
      throw new CommandError("INVALID_COMMAND", `Unsupported command ${String(exhaustive)}`);
    }
  }
}

function filterComponents(
  entity: EntityDefinition,
  selectComponents: string[] | undefined,
): EntityDefinition {
  if (!selectComponents) {
    return structuredClone(entity);
  }

  const components: Record<string, JsonValue> = {};
  for (const name of selectComponents) {
    const value = entity.components[name];
    if (value !== undefined) {
      components[name] = structuredClone(value);
    }
  }

  return {
    id: entity.id,
    name: entity.name,
    ...(entity.parentId ? { parentId: entity.parentId } : {}),
    components,
  };
}

export class CommandBus {
  #project: ProjectDocument;
  #revision: number;
  #events: CommandEvent[] = [];
  #undoSnapshots = new Map<string, ProjectDocument>();
  #undoCounter = 0;
  #eventCounter = 0;

  constructor(project: ProjectDocument, initialRevision = 0) {
    assertValidProject(project);
    this.#project = cloneProject(project);
    this.#revision = initialRevision;
  }

  get revision(): number {
    return this.#revision;
  }

  snapshot(): CommandBusSnapshot {
    return {
      revision: this.#revision,
      project: cloneProject(this.#project),
    };
  }

  executeUnknown(input: unknown): CommandResult {
    return this.execute(parseEngineCommand(input));
  }

  execute(command: EngineCommand): CommandResult {
    return this.executeTransaction([command], {
      ...(command.expectedProjectRevision !== undefined
        ? { expectedProjectRevision: command.expectedProjectRevision }
        : {}),
      ...(command.dryRun !== undefined ? { dryRun: command.dryRun } : {}),
    });
  }

  executeTransaction(commands: EngineCommand[], options: ExecuteOptions = {}): CommandResult {
    assertRevision(options.expectedProjectRevision, this.#revision);

    for (const command of commands) {
      assertRevision(command.expectedProjectRevision, this.#revision);
    }

    const before = cloneProject(this.#project);
    const working = cloneProject(this.#project);
    const changes: ChangeRecord[] = [];

    for (const command of commands) {
      changes.push(...applyCommand(working, command));
    }

    assertValidProject(working);

    const proposedRevision = this.#revision + 1;
    const dryRun = options.dryRun === true || commands.some((command) => command.dryRun === true);

    if (dryRun) {
      return {
        ok: true,
        revision: this.#revision,
        proposedRevision,
        changes,
        warnings: [],
      };
    }

    this.#project = working;
    this.#revision = proposedRevision;

    const undoToken = `undo_${++this.#undoCounter}`;
    this.#undoSnapshots.set(undoToken, before);

    this.#events.push({
      id: `event_${++this.#eventCounter}`,
      operation: "execute",
      revision: this.#revision,
      commands: structuredClone(commands),
      changes: structuredClone(changes),
    });

    return {
      ok: true,
      revision: this.#revision,
      proposedRevision: this.#revision,
      changes,
      warnings: [],
      undoToken,
    };
  }

  undo(undoToken: string, expectedProjectRevision?: number): CommandResult {
    assertRevision(expectedProjectRevision, this.#revision);
    const previous = this.#undoSnapshots.get(undoToken);

    if (!previous) {
      throw new CommandError("INVALID_COMMAND", `Unknown or already-consumed undo token "${undoToken}"`);
    }

    this.#undoSnapshots.delete(undoToken);
    this.#project = cloneProject(previous);
    this.#revision += 1;

    const changes: ChangeRecord[] = [{ kind: "updated", id: this.#project.projectId, resource: "project" }];

    this.#events.push({
      id: `event_${++this.#eventCounter}`,
      operation: "undo",
      revision: this.#revision,
      commands: [],
      changes: structuredClone(changes),
    });

    return {
      ok: true,
      revision: this.#revision,
      proposedRevision: this.#revision,
      changes,
      warnings: [],
    };
  }

  queryEntities(query: EntityQuery = {}): EntityQueryResult {
    const matched: EntityQueryItem[] = [];

    for (const scene of this.#project.scenes) {
      if (query.sceneId && query.sceneId !== scene.id) {
        continue;
      }

      for (const entity of scene.entities) {
        if (query.ids && !query.ids.includes(entity.id)) {
          continue;
        }
        if (query.component && entity.components[query.component] === undefined) {
          continue;
        }
        if (
          query.nameContains &&
          !entity.name.toLocaleLowerCase().includes(query.nameContains.toLocaleLowerCase())
        ) {
          continue;
        }

        matched.push({
          sceneId: scene.id,
          entity: filterComponents(entity, query.selectComponents),
        });
      }
    }

    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    const items = matched.slice(offset, offset + limit);
    const nextOffset = offset + items.length < matched.length ? offset + items.length : undefined;

    return {
      items,
      total: matched.length,
      offset,
      limit,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    };
  }

  eventLog(): CommandEvent[] {
    return structuredClone(this.#events);
  }
}
