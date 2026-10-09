import {
  CommandBus,
  type CommandResult,
  type EngineCommand,
  type EntityQuery,
} from "@kinetra/command-bus";
import {
  newId,
  type ComponentMap,
  type JsonObject,
  type ProjectDocument,
} from "@kinetra/project-model";

import {
  AcceptanceRunner,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
  type AcceptanceReport,
} from "@kinetra/verification";

import { ElectronRuntimeHost } from "./electron-runtime.js";
import {
  resolvePackagedExecutable,
  InfrastructureError,
} from "./packaged-resolver.js";
import {
  LocalRuntimeHost,
  type RuntimeHost,
  type RuntimeInputEvent,
  type RuntimeQuery,
} from "./runtime.js";
import { compareCodeUnits } from "./order.js";
import { FileProjectStore, type ProjectStore } from "./store.js";

export interface RunAcceptanceInput {
  manifest: AcceptanceManifest;
  target?: "runtime" | "packaged";
  project?: ProjectDocument;
  timeoutMs?: number;
  testScriptPreset?: string;
  /** Game module id the player should run, e.g. "orb-run". Omitted runs the default game (Arena). */
  game?: string;
  assets?: Record<string, string>;
}

export interface SceneCreateInput {
  name: string;
  id?: string;
  expectedProjectRevision?: number;
  dryRun?: boolean;
}

export interface EntityCreateInput {
  sceneId: string;
  name: string;
  id?: string;
  parentId?: string;
  components?: ComponentMap;
  expectedProjectRevision?: number;
  dryRun?: boolean;
}

export interface EntityPatchInput {
  entityId: string;
  component: string;
  patch: JsonObject;
  expectedProjectRevision?: number;
  dryRun?: boolean;
}

export interface EntityReparentInput {
  entityId: string;
  parentId?: string;
  expectedProjectRevision?: number;
  dryRun?: boolean;
}

export interface EntityDeleteInput {
  entityId: string;
  cascade?: boolean;
  expectedProjectRevision?: number;
  dryRun?: boolean;
}

export class KinetraAgentService {
  readonly bus: CommandBus;
  readonly runtime: RuntimeHost;
  readonly store: ProjectStore | undefined;
  /** True while the in-memory project may be ahead of what the store last accepted. */
  #unsaved = false;

  constructor(
    project: ProjectDocument,
    options: {
      initialRevision?: number;
      store?: ProjectStore;
      runtime?: RuntimeHost;
    } = {},
  ) {
    this.bus = new CommandBus(project, options.initialRevision ?? 0);
    this.store = options.store;
    this.runtime = options.runtime ?? new LocalRuntimeHost();
  }

  static async fromFile(
    path: string,
    options: { runtime?: RuntimeHost } = {},
  ): Promise<KinetraAgentService> {
    const store = new FileProjectStore(path);
    const project = await store.load();

    return new KinetraAgentService(project, {
      store,
      ...(options.runtime ? { runtime: options.runtime } : {}),
    });
  }

  inspectProject(): {
    revision: number;
    projectId: string;
    name: string;
    schemaVersion: number;
    scenes: Array<{ id: string; name: string; entityCount: number }>;
  } {
    const snapshot = this.bus.snapshot();

    return {
      revision: snapshot.revision,
      projectId: snapshot.project.projectId,
      name: snapshot.project.name,
      schemaVersion: snapshot.project.schemaVersion,
      scenes: snapshot.project.scenes
        .map((scene) => ({
          id: scene.id,
          name: scene.name,
          entityCount: scene.entities.length,
        }))
        .sort((left, right) => compareCodeUnits(left.id, right.id)),
    };
  }

  diffSince(sinceRevision: number): {
    currentRevision: number;
    events: ReturnType<CommandBus["eventLog"]>;
  } {
    return {
      currentRevision: this.bus.revision,
      events: this.bus
        .eventLog()
        .filter((event) => event.revision > sinceRevision),
    };
  }

  queryScenes(id?: string): Array<{
    id: string;
    name: string;
    entityCount: number;
  }> {
    const snapshot = this.bus.snapshot();

    return snapshot.project.scenes
      .filter((scene) => (id ? scene.id === id : true))
      .map((scene) => ({
        id: scene.id,
        name: scene.name,
        entityCount: scene.entities.length,
      }))
      .sort((left, right) => compareCodeUnits(left.id, right.id));
  }

  queryEntities(query: EntityQuery = {}) {
    return this.bus.queryEntities(query);
  }

  async createScene(input: SceneCreateInput): Promise<CommandResult> {
    return this.#execute({
      requestId: newId("test"),
      command: "scene.create",
      ...(input.expectedProjectRevision !== undefined
        ? { expectedProjectRevision: input.expectedProjectRevision }
        : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      payload: {
        scene: {
          id: input.id ?? newId("scene"),
          name: input.name,
          entities: [],
        },
      },
    });
  }

  async createEntity(input: EntityCreateInput): Promise<CommandResult> {
    return this.#execute({
      requestId: newId("test"),
      command: "entity.create",
      ...(input.expectedProjectRevision !== undefined
        ? { expectedProjectRevision: input.expectedProjectRevision }
        : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      payload: {
        sceneId: input.sceneId,
        entity: {
          id: input.id ?? newId("entity"),
          name: input.name,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          components: structuredClone(input.components ?? {}),
        },
      },
    });
  }

  async patchComponent(input: EntityPatchInput): Promise<CommandResult> {
    return this.#execute({
      requestId: newId("test"),
      command: "component.patch",
      ...(input.expectedProjectRevision !== undefined
        ? { expectedProjectRevision: input.expectedProjectRevision }
        : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      payload: {
        entityId: input.entityId,
        component: input.component,
        patch: structuredClone(input.patch),
      },
    });
  }

  async reparentEntity(input: EntityReparentInput): Promise<CommandResult> {
    return this.#execute({
      requestId: newId("test"),
      command: "entity.reparent",
      ...(input.expectedProjectRevision !== undefined
        ? { expectedProjectRevision: input.expectedProjectRevision }
        : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      payload: {
        entityId: input.entityId,
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      },
    });
  }

  async deleteEntity(input: EntityDeleteInput): Promise<CommandResult> {
    return this.#execute({
      requestId: newId("test"),
      command: "entity.delete",
      ...(input.expectedProjectRevision !== undefined
        ? { expectedProjectRevision: input.expectedProjectRevision }
        : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      payload: {
        entityId: input.entityId,
        ...(input.cascade !== undefined ? { cascade: input.cascade } : {}),
      },
    });
  }

  async undo(undoToken: string, expectedProjectRevision?: number): Promise<CommandResult> {
    const before = this.bus.revision;
    let result: CommandResult;
    try {
      result = this.bus.undo(undoToken, expectedProjectRevision);
    } catch (error) {
      // A refused undo changes nothing, but a retry of an undo whose save failed lands here
      // (its token is spent): flush the pending state so disk catches up with memory.
      await this.#flushUnsaved();
      throw error;
    }
    // The undo token is single-use, so when this save fails the in-memory project stays undone
    // and cannot be redone. Track that memory is ahead of disk so the next call saves the whole
    // project again.
    await this.#persistIfMutated(before, result, true);
    return result;
  }

  async startRuntime(sceneId: string): Promise<void> {
    const snapshot = this.bus.snapshot();
    await this.runtime.start(snapshot.project, sceneId, snapshot.revision);
  }

  async stopRuntime(): Promise<void> {
    await this.runtime.stop();
  }

  async queryRuntime(query: RuntimeQuery = {}) {
    return this.runtime.query(query);
  }

  async injectRuntimeInput(event: RuntimeInputEvent): Promise<void> {
    await this.runtime.injectInput(event);
  }

  async captureRuntimeFrame() {
    return this.runtime.captureFrame();
  }

  async readRuntimeLogs(sinceSequence = 0) {
    return this.runtime.readLogs(sinceSequence);
  }

  async runAcceptance(input: RunAcceptanceInput): Promise<AcceptanceReport> {
    if (!input.manifest || typeof input.manifest !== "object") {
      throw new InfrastructureError(
        "AcceptanceManifest is required",
        "INVALID_MANIFEST",
      );
    }
    if (input.manifest.schemaVersion !== 1) {
      throw new InfrastructureError(
        `Unsupported acceptance manifest schemaVersion: ${String(input.manifest.schemaVersion)}`,
        "UNSUPPORTED_SCHEMA_VERSION",
      );
    }

    const target = input.target ?? input.manifest.target ?? "runtime";
    if (target !== "runtime" && target !== "packaged") {
      throw new InfrastructureError(
        `Invalid target "${String(target)}". Must be "runtime" or "packaged".`,
        "INVALID_TARGET",
      );
    }

    const project = input.project ?? (this.bus.snapshot().project as ProjectDocument);
    if (!project || !Array.isArray(project.scenes)) {
      throw new InfrastructureError(
        "A valid ProjectDocument is required to run acceptance tests",
        "INVALID_PROJECT",
      );
    }

    let host: ElectronRuntimeHost;
    let resolvedExecutable: string | undefined;

    if (target === "packaged") {
      const resolution = resolvePackagedExecutable();
      resolvedExecutable = resolution.path;
      host = new ElectronRuntimeHost({
        runtimeExecutable: resolution.path,
        requestTimeoutMs: input.timeoutMs ?? 30_000,
      });
    } else {
      host = new ElectronRuntimeHost({
        runtimeExecutable: undefined,
        requestTimeoutMs: input.timeoutMs ?? 30_000,
      });
      resolvedExecutable = host.electronExecutable;
    }

    const probe = new KinetraRuntimeProbe({
      host,
      project,
      initialRevision: this.bus.revision,
      closeOnStop: false,
      ...(input.testScriptPreset ? { testScriptPreset: input.testScriptPreset } : {}),
      ...(input.game !== undefined ? { game: input.game } : {}),
      ...(input.assets ? { assets: input.assets } : {}),
    });

    const runner = new AcceptanceRunner(probe);
    const effectiveManifest: AcceptanceManifest = {
      ...input.manifest,
      target,
    };

    try {
      const report = await runner.run(effectiveManifest);

      // Collect structured process-level observations proving executed target
      let hostInfo: Record<string, unknown> | undefined;
      try {
        hostInfo = await host.getHostInfo();
      } catch {
        // Process may already have stopped or closed
      }

      report.observations = {
        ...report.observations,
        target,
        resolvedExecutable,
        ...(hostInfo ? { hostInfo } : {}),
      };

      return report;
    } finally {
      await probe.close().catch(() => {});
      await host.close().catch(() => {});
    }
  }

  async #execute(command: EngineCommand): Promise<CommandResult> {
    const before = this.bus.revision;
    const wasUnsaved = this.#unsaved;
    const result = this.bus.execute(command);
    try {
      await this.#persistIfMutated(before, result);
    } catch (error) {
      // The save failed, so memory is ahead of disk: roll the command back so the caller's
      // error matches reality and the same command can be retried. When another command has
      // already been applied meanwhile, undo is refused (it is last-in-first-out); that later
      // command's save writes the whole project, so memory and disk converge anyway.
      if (result.undoToken !== undefined && this.bus.revision === result.revision) {
        try {
          this.bus.undo(result.undoToken, result.revision);
          // Memory is back to what it was before the command, so it is exactly as (un)saved
          // as it was then.
          this.#unsaved = wasUnsaved;
        } catch {
          // Keep the original persistence error as the one reported.
        }
      }
      throw error;
    }
    return result;
  }

  async #persistIfMutated(
    beforeRevision: number,
    result: CommandResult,
    flushPending = false,
  ): Promise<void> {
    if (!this.store) {
      return;
    }
    if (result.revision !== beforeRevision) {
      this.#unsaved = true;
    } else if (!(flushPending && this.#unsaved)) {
      return;
    }

    await this.store.save(this.bus.snapshot().project);
    this.#unsaved = false;
  }

  async #flushUnsaved(): Promise<void> {
    if (!this.store || !this.#unsaved) {
      return;
    }
    try {
      await this.store.save(this.bus.snapshot().project);
      this.#unsaved = false;
    } catch {
      // Still unsaved; the caller reports the original error.
    }
  }
}
