import {
  CommandError,
  type ChangeRecord,
  type CommandBus,
  type CommandResult,
  type EngineCommand,
} from "@kinetra/command-bus";
import type { ComponentMap, EntityDefinition, JsonObject } from "@kinetra/project-model";

import { buildHierarchy, type HierarchyNode } from "./hierarchy.js";

export interface SceneSummary {
  id: string;
  name: string;
  entityCount: number;
}

export interface InspectedEntity {
  sceneId: string;
  entity: EntityDefinition;
}

export interface EditorSessionOptions {
  /** Prefix of the requestId the editor stamps on every command it sends. Default "editor". */
  requestIdPrefix?: string;
}

interface HistoryEntry {
  undoToken: string;
  commands: EngineCommand[];
}

const MAX_SELECTION = 500;

/**
 * The observer editor's only gateway to the project. It reads snapshots from a CommandBus and
 * writes exclusively by sending typed commands to that same bus, exactly like an MCP client; there
 * is no privileged mutation path and no editor-owned copy of the project to drift out of sync.
 *
 * Undo/redo is scoped to the editor's own edits. The bus is last-in-first-out, so if another
 * client (an agent) commits on top, the editor's next undo fails with a structured UNDO_CONFLICT
 * rather than silently rewinding the other client's work, and any pending redo is dropped.
 */
export class EditorSession {
  readonly #bus: CommandBus;
  readonly #prefix: string;
  #requestCounter = 0;
  #undoStack: HistoryEntry[] = [];
  #redoStack: EngineCommand[][] = [];
  #knownRevision: number;
  #selection: string[] = [];

  constructor(bus: CommandBus, options: EditorSessionOptions = {}) {
    this.#bus = bus;
    this.#prefix = options.requestIdPrefix ?? "editor";
    this.#knownRevision = bus.revision;
  }

  get revision(): number {
    return this.#bus.revision;
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    this.#dropStaleRedo();
    return this.#redoStack.length > 0;
  }

  scenes(): SceneSummary[] {
    return this.#bus.snapshot().project.scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      entityCount: scene.entities.length,
    }));
  }

  /** Hierarchy rows for one scene (see {@link buildHierarchy}). */
  hierarchy(sceneId: string): HierarchyNode[] {
    const scene = this.#bus.snapshot().project.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) {
      throw new CommandError("SCENE_NOT_FOUND", `Scene "${sceneId}" does not exist`);
    }
    return buildHierarchy(scene);
  }

  /** The entity as the inspector shows it, or undefined when it does not exist. */
  inspect(entityId: string): InspectedEntity | undefined {
    const [item] = this.#bus.queryEntities({ ids: [entityId], limit: 1 }).items;
    return item ? { sceneId: item.sceneId, entity: item.entity } : undefined;
  }

  /** Selected entity ids in selection order; ids that no longer exist (deleted, undone) are dropped. */
  get selection(): readonly string[] {
    if (this.#selection.length > 0) {
      const alive = this.#existing(this.#selection);
      this.#selection = this.#selection.filter((id) => alive.has(id));
    }
    return [...this.#selection];
  }

  select(entityIds: readonly string[]): void {
    const unique = [...new Set(entityIds)];
    if (unique.length > MAX_SELECTION) {
      throw new CommandError("INVALID_COMMAND", `Cannot select more than ${MAX_SELECTION} entities at once`);
    }
    const found = this.#existing(unique);
    const missing = unique.find((id) => !found.has(id));
    if (missing !== undefined) {
      throw new CommandError("ENTITY_NOT_FOUND", `Entity "${missing}" does not exist`);
    }
    this.#selection = unique;
  }

  clearSelection(): void {
    this.#selection = [];
  }

  createScene(input: { id: string; name: string }): CommandResult {
    return this.#run([
      {
        ...this.#base(),
        command: "scene.create",
        payload: { scene: { id: input.id, name: input.name, entities: [] } },
      },
    ]);
  }

  createEntity(input: {
    sceneId: string;
    id: string;
    name: string;
    parentId?: string;
    components?: ComponentMap;
  }): CommandResult {
    return this.#run([
      {
        ...this.#base(),
        command: "entity.create",
        payload: {
          sceneId: input.sceneId,
          entity: {
            id: input.id,
            name: input.name,
            ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
            components: structuredClone(input.components ?? {}),
          },
        },
      },
    ]);
  }

  /** Inspector edit: merges `patch` into one component. */
  patchComponent(entityId: string, component: string, patch: JsonObject): CommandResult {
    return this.#run([
      {
        ...this.#base(),
        command: "component.patch",
        payload: { entityId, component, patch: structuredClone(patch) },
      },
    ]);
  }

  /** Hierarchy drag-and-drop; omit `parentId` to move the entity to the scene root. */
  reparent(entityId: string, parentId?: string): CommandResult {
    return this.#run([
      {
        ...this.#base(),
        command: "entity.reparent",
        payload: { entityId, ...(parentId !== undefined ? { parentId } : {}) },
      },
    ]);
  }

  deleteEntity(entityId: string, cascade = false): CommandResult {
    return this.#run([
      {
        ...this.#base(),
        command: "entity.delete",
        payload: { entityId, ...(cascade ? { cascade: true } : {}) },
      },
    ]);
  }

  /** Undoes the editor's most recent edit through the bus's own undo. */
  undo(): CommandResult {
    const entry = this.#undoStack.at(-1);
    if (!entry) {
      throw new CommandError("INVALID_COMMAND", "Nothing to undo");
    }
    this.#dropStaleRedo();
    const result = this.#bus.undo(entry.undoToken);
    this.#undoStack.pop();
    this.#redoStack.push(entry.commands);
    this.#knownRevision = this.#bus.revision;
    return result;
  }

  /** Re-sends the commands of the most recently undone edit (with fresh request ids). */
  redo(): CommandResult {
    this.#dropStaleRedo();
    const commands = this.#redoStack.at(-1);
    if (!commands) {
      throw new CommandError("INVALID_COMMAND", "Nothing to redo");
    }
    const resend = commands.map((command) => ({ ...structuredClone(command), ...this.#base() }));
    const result = this.#bus.executeTransaction(resend, {
      expectedProjectRevision: this.#bus.revision,
    });
    this.#redoStack.pop();
    this.#recordUndo(result, resend);
    this.#knownRevision = this.#bus.revision;
    return result;
  }

  #existing(ids: readonly string[]): Set<string> {
    if (ids.length === 0) {
      return new Set();
    }
    return new Set(
      this.#bus.queryEntities({ ids: [...ids], limit: MAX_SELECTION }).items.map((item) => item.entity.id),
    );
  }

  #base(): { requestId: string } {
    return { requestId: `${this.#prefix}_${++this.#requestCounter}` };
  }

  #run(commands: EngineCommand[]): CommandResult {
    const result = this.#bus.executeTransaction(commands);
    // A committed edit starts a new timeline: whatever was undone no longer applies.
    this.#redoStack = [];
    this.#recordUndo(result, commands);
    this.#knownRevision = this.#bus.revision;
    return result;
  }

  #recordUndo(result: CommandResult, commands: EngineCommand[]): void {
    if (result.undoToken !== undefined) {
      this.#undoStack.push({ undoToken: result.undoToken, commands: structuredClone(commands) });
    }
  }

  /** Another client committed since the editor last acted: replaying our redo would be a guess. */
  #dropStaleRedo(): void {
    if (this.#bus.revision !== this.#knownRevision) {
      this.#redoStack = [];
    }
  }
}

/** Compact, order-stable summary of what a result changed, for status bars and tests. */
export function describeChanges(changes: readonly ChangeRecord[]): string[] {
  return changes.map((change) => `${change.kind} ${change.resource} ${change.id}`);
}
