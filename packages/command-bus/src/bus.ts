import {
  assertValidProject,
  cloneProject,
  type EntityDefinition,
  type JsonObject,
  type JsonValue,
  type ProjectDocument,
  ProjectValidationError,
  type SceneDefinition,
} from "@kinetra/project-model";

import { CommandError } from "./errors.js";
import { parseEngineCommand } from "./validation.js";
import type {
  ChangeRecord,
  CommandBusOptions,
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

/** Own-property read: component names such as "toString" must not resolve to Object.prototype members. */
function ownComponent(entity: EntityDefinition, name: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(entity.components, name)
    ? entity.components[name]
    : undefined;
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

const RESERVED_COMPONENT_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function assertComponentName(component: string): void {
  if (RESERVED_COMPONENT_NAMES.has(component)) {
    throw new CommandError(
      "INVALID_COMMAND",
      `Component name "${component}" is reserved and cannot be stored as component data`,
    );
  }
}

function isAncestorOrSelf(scene: SceneDefinition, candidateId: string, entityId: string): boolean {
  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const visited = new Set<string>();
  let cursor: string | undefined = candidateId;
  while (cursor !== undefined && !visited.has(cursor)) {
    if (cursor === entityId) {
      return true;
    }
    visited.add(cursor);
    cursor = byId.get(cursor)?.parentId;
  }
  return false;
}

function normalizeOffset(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value !== undefined && Number.isFinite(value) ? Math.floor(value) : 100;
  return Math.min(500, Math.max(1, limit));
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
        throw new CommandError(
          "SCENE_NOT_FOUND",
          `Scene "${command.payload.sceneId}" does not exist`,
        );
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
        throw new CommandError(
          "PARENT_NOT_FOUND",
          `Parent "${command.payload.entity.parentId}" does not exist in scene "${scene.id}"`,
        );
      }

      scene.entities.push(structuredClone(command.payload.entity));
      return [{ kind: "created", id: command.payload.entity.id, resource: "entity" }];
    }

    case "component.patch": {
      assertComponentName(command.payload.component);
      const located = findEntity(project, command.payload.entityId);
      if (!located) {
        throw new CommandError(
          "ENTITY_NOT_FOUND",
          `Entity "${command.payload.entityId}" does not exist`,
        );
      }

      const existing = ownComponent(located.entity, command.payload.component);
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
        throw new CommandError(
          "ENTITY_NOT_FOUND",
          `Entity "${command.payload.entityId}" does not exist`,
        );
      }

      if (command.payload.parentId) {
        const parent = located.scene.entities.find(
          (candidate) => candidate.id === command.payload.parentId,
        );
        if (!parent) {
          throw new CommandError(
            "PARENT_NOT_FOUND",
            `Parent "${command.payload.parentId}" does not exist in the same scene`,
          );
        }
        if (isAncestorOrSelf(located.scene, parent.id, located.entity.id)) {
          throw new CommandError(
            "PARENT_CYCLE",
            `Cannot parent "${located.entity.id}" under "${parent.id}": it would create a hierarchy cycle`,
          );
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
        throw new CommandError(
          "ENTITY_NOT_FOUND",
          `Entity "${command.payload.entityId}" does not exist`,
        );
      }

      const directChildren = located.scene.entities.filter(
        (entity) => entity.parentId === located.entity.id,
      );

      if (directChildren.length > 0 && command.payload.cascade !== true) {
        throw new CommandError(
          "CHILDREN_EXIST",
          `Entity "${located.entity.id}" has children; set cascade=true to delete the subtree`,
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
    const value = ownComponent(entity, name);
    if (value !== undefined) {
      // defineProperty, not assignment: a JSON.parse'd "__proto__" component is an own data
      // property, and `components["__proto__"] = ...` would re-prototype the result and drop it.
      Object.defineProperty(components, name, {
        value: structuredClone(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  return {
    id: entity.id,
    name: entity.name,
    ...(entity.parentId ? { parentId: entity.parentId } : {}),
    components,
  };
}

/** Default number of undo snapshots (each a full project clone) the bus retains. */
export const DEFAULT_MAX_UNDO_DEPTH = 100;
/** Default number of command events the bus retains in its replay log. */
export const DEFAULT_MAX_EVENT_LOG_LENGTH = 10_000;

function resolveBound(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  // Infinity is the explicit opt-out of a bound.
  if (value === Infinity || (Number.isInteger(value) && value >= 1)) {
    return value;
  }
  throw new RangeError(`${name} must be a positive integer (or Infinity), received ${String(value)}`);
}

function undoTokenNumber(token: string): number | undefined {
  const match = /^undo_([1-9]\d*)$/.exec(token);
  return match ? Number(match[1]) : undefined;
}

const MAX_REPORTED_ISSUES = 3;

/**
 * Validate the project a transaction would produce. A project-model
 * `ProjectValidationError` here means the *command* asked for something the
 * schema forbids (a Date value, an empty parentId, ...), so surface it as the
 * bus's structured `INVALID_COMMAND` with the offending paths rather than a
 * raw model error that callers cannot branch on.
 */
function assertResultingProjectValid(working: ProjectDocument): void {
  try {
    assertValidProject(working);
  } catch (error) {
    if (!(error instanceof ProjectValidationError)) throw error;
    const shown = error.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    const more = error.issues.length > MAX_REPORTED_ISSUES ? ` (+${error.issues.length - MAX_REPORTED_ISSUES} more)` : "";
    throw new CommandError(
      "INVALID_COMMAND",
      `Command would produce an invalid project: ${shown}${more}`,
      undefined,
      error.issues.map((issue) => ({ ...issue })),
    );
  }
}

export class CommandBus {
  #project: ProjectDocument;
  #revision: number;
  #events: CommandEvent[] = [];
  // Last-in, first-out: only the most recent un-undone execution can be undone,
  // so restoring a snapshot never silently discards later changes.
  #undoStack: Array<{ token: string; snapshot: ProjectDocument }> = [];
  #undoCounter = 0;
  #eventCounter = 0;
  #maxUndoDepth: number;
  #maxEventLogLength: number;
  // Highest undo counter dropped from the front of the bounded stack.
  #evictedUndoThrough = 0;
  #droppedEvents = 0;

  constructor(project: ProjectDocument, initialRevision = 0, options: CommandBusOptions = {}) {
    assertValidProject(project);
    // A NaN/negative/fractional/string start revision would make every later revision NaN (or
    // fractional) and break expectedProjectRevision for the rest of the session.
    if (typeof initialRevision !== "number" || !Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw new RangeError(
        `initialRevision must be a non-negative safe integer, received ${String(initialRevision)}`,
      );
    }
    this.#maxUndoDepth = resolveBound("maxUndoDepth", options.maxUndoDepth, DEFAULT_MAX_UNDO_DEPTH);
    this.#maxEventLogLength = resolveBound(
      "maxEventLogLength",
      options.maxEventLogLength,
      DEFAULT_MAX_EVENT_LOG_LENGTH,
    );
    this.#project = cloneProject(project);
    this.#revision = initialRevision;
  }

  get revision(): number {
    return this.#revision;
  }

  /** Number of events that fell out of the bounded event log (so a consumer can detect a gap). */
  get droppedEventCount(): number {
    return this.#droppedEvents;
  }

  #pushEvent(event: CommandEvent): void {
    this.#events.push(event);
    const overflow = this.#events.length - this.#maxEventLogLength;
    if (overflow > 0) {
      this.#events.splice(0, overflow);
      this.#droppedEvents += overflow;
    }
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
    // An empty transaction changes nothing, so it must not bump the revision, push an
    // undo entry (a full project clone) or log an event that claims something happened.
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new CommandError("INVALID_COMMAND", "A transaction needs at least one command");
    }

    assertRevision(options.expectedProjectRevision, this.#revision);

    for (const command of commands) {
      assertRevision(command.expectedProjectRevision, this.#revision);
    }

    // The committed document is only ever replaced, never mutated in place (commands run on
    // `working`), so the current object can serve as the undo snapshot without a second clone.
    const before = this.#project;
    const working = cloneProject(this.#project);
    const changes: ChangeRecord[] = [];

    for (const command of commands) {
      changes.push(...applyCommand(working, command));
    }

    assertResultingProjectValid(working);

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
    this.#undoStack.push({ token: undoToken, snapshot: before });
    while (this.#undoStack.length > this.#maxUndoDepth) {
      const evicted = this.#undoStack.shift()!;
      this.#evictedUndoThrough = Math.max(
        this.#evictedUndoThrough,
        undoTokenNumber(evicted.token) ?? 0,
      );
    }

    this.#pushEvent({
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
    const index = this.#undoStack.findIndex((entry) => entry.token === undoToken);

    if (index === -1) {
      const number = undoTokenNumber(undoToken);
      if (number !== undefined && number <= this.#evictedUndoThrough) {
        throw new CommandError(
          "UNDO_EXPIRED",
          `Undo token "${undoToken}" is no longer in the undo history (maxUndoDepth=${this.#maxUndoDepth}) or was already consumed`,
        );
      }
      throw new CommandError("INVALID_COMMAND", `Unknown or already-consumed undo token "${undoToken}"`);
    }

    if (index !== this.#undoStack.length - 1) {
      const newer = this.#undoStack.length - 1 - index;
      throw new CommandError(
        "UNDO_CONFLICT",
        `Undo token "${undoToken}" is not the most recent change; ${newer} newer change(s) must be undone first`,
      );
    }

    const [entry] = this.#undoStack.splice(index, 1);
    this.#project = cloneProject(entry!.snapshot);
    this.#revision += 1;

    const changes: ChangeRecord[] = [{ kind: "updated", id: this.#project.projectId, resource: "project" }];

    this.#pushEvent({
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
        if (query.component && ownComponent(entity, query.component) === undefined) {
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

    const offset = normalizeOffset(query.offset);
    const limit = normalizeLimit(query.limit);
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
