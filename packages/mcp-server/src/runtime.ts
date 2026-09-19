import type { ProjectDocument } from "@kinetra/project-model";
import { ThreeSceneRuntime } from "@kinetra/renderer-three";

export type RuntimeLogLevel = "debug" | "info" | "warning" | "error";

export interface RuntimeLogEntry {
  sequence: number;
  level: RuntimeLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface RuntimeEntityState {
  entityId: string;
  name: string;
  objectType: string;
  parentEntityId?: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface RuntimeQuery {
  entityIds?: string[];
}

export interface RuntimeQueryResult {
  running: boolean;
  sceneId?: string;
  projectRevision?: number;
  entities: RuntimeEntityState[];
}

export interface RuntimeInputEvent {
  action: string;
  phase: "press" | "release" | "hold";
  value?: number | [number, number];
  durationMs?: number;
}

export interface RuntimeFrameCapture {
  available: boolean;
  mimeType?: string;
  base64?: string;
  reason?: string;
  fallbackState?: RuntimeQueryResult;
}

export interface RuntimeHost {
  start(project: ProjectDocument, sceneId: string, projectRevision: number): Promise<void>;
  stop(): Promise<void>;
  query(query?: RuntimeQuery): Promise<RuntimeQueryResult>;
  injectInput(event: RuntimeInputEvent): Promise<void>;
  captureFrame(): Promise<RuntimeFrameCapture>;
  readLogs(sinceSequence?: number): Promise<RuntimeLogEntry[]>;
  step?(steps?: number, deltaSeconds?: number): Promise<RuntimeQueryResult>;
}

export class LocalRuntimeHost implements RuntimeHost {
  #runtime: ThreeSceneRuntime | undefined;
  #projectRevision: number | undefined;
  #logs: RuntimeLogEntry[] = [];
  #nextLogSequence = 1;

  async start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
  ): Promise<void> {
    await this.stop();

    this.#runtime = ThreeSceneRuntime.instantiate(project, sceneId);
    this.#projectRevision = projectRevision;
    this.#log("info", "runtime.started", { sceneId, projectRevision });
  }

  async stop(): Promise<void> {
    if (!this.#runtime) {
      return;
    }

    const sceneId = this.#runtime.sceneId;
    this.#runtime.dispose();
    this.#runtime = undefined;
    this.#projectRevision = undefined;
    this.#log("info", "runtime.stopped", { sceneId });
  }

  async query(query: RuntimeQuery = {}): Promise<RuntimeQueryResult> {
    if (!this.#runtime) {
      return { running: false, entities: [] };
    }

    const requested = query.entityIds ? new Set(query.entityIds) : undefined;
    const entities: RuntimeEntityState[] = [];

    for (const [entityId, object] of this.#runtime.objects()) {
      if (requested && !requested.has(entityId)) {
        continue;
      }

      const parentEntityId =
        typeof object.parent?.userData?.kinetra?.entityId === "string"
          ? object.parent.userData.kinetra.entityId
          : undefined;

      entities.push({
        entityId,
        name: object.name,
        objectType: object.type,
        ...(parentEntityId ? { parentEntityId } : {}),
        position: [object.position.x, object.position.y, object.position.z],
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
        scale: [object.scale.x, object.scale.y, object.scale.z],
      });
    }

    entities.sort((left, right) => left.entityId.localeCompare(right.entityId));

    return {
      running: true,
      sceneId: this.#runtime.sceneId,
      ...(this.#projectRevision !== undefined
        ? { projectRevision: this.#projectRevision }
        : {}),
      entities,
    };
  }

  async injectInput(event: RuntimeInputEvent): Promise<void> {
    if (!this.#runtime) {
      throw new Error("Runtime is not running");
    }

    this.#log("debug", "runtime.input", {
      action: event.action,
      phase: event.phase,
      ...(event.value !== undefined ? { value: event.value } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    });
  }

  async step(_steps = 1, _deltaSeconds = 1 / 60): Promise<RuntimeQueryResult> {
    return this.query();
  }

  async captureFrame(): Promise<RuntimeFrameCapture> {
    const fallbackState = await this.query();

    return {
      available: false,
      reason:
        "The local scene-graph runtime has no raster surface. Connect an Electron/browser runtime host for PNG capture.",
      fallbackState,
    };
  }

  async readLogs(sinceSequence = 0): Promise<RuntimeLogEntry[]> {
    return this.#logs
      .filter((entry) => entry.sequence > sinceSequence)
      .map((entry) => structuredClone(entry));
  }

  #log(
    level: RuntimeLogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.#logs.push({
      sequence: this.#nextLogSequence++,
      level,
      message,
      ...(data ? { data: structuredClone(data) } : {}),
    });
  }
}
