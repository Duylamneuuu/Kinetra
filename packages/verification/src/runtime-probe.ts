import type { ProjectDocument } from "@kinetra/project-model";

import type {
  RuntimeInput,
  RuntimeLog,
  RuntimeMetrics,
  RuntimeProbe,
  RuntimeProbeHost,
  RuntimeSnapshot,
} from "./types.js";

export interface KinetraRuntimeProbeOptions {
  host: RuntimeProbeHost;
  project: ProjectDocument | (() => ProjectDocument | Promise<ProjectDocument>);
  initialRevision?: number;
  closeOnStop?: boolean;
}

export class KinetraRuntimeProbe implements RuntimeProbe {
  readonly #host: RuntimeProbeHost;
  readonly #project:
    | ProjectDocument
    | (() => ProjectDocument | Promise<ProjectDocument>);
  readonly #initialRevision: number;
  readonly #closeOnStop: boolean;
  #currentSceneId: string | undefined;

  constructor(options: KinetraRuntimeProbeOptions) {
    this.#host = options.host;
    this.#project = options.project;
    this.#initialRevision = options.initialRevision ?? 0;
    this.#closeOnStop = options.closeOnStop ?? false;
  }

  async start(sceneId: string, _seed: number): Promise<void> {
    const project =
      typeof this.#project === "function"
        ? await this.#project()
        : this.#project;

    this.#currentSceneId = sceneId;
    await this.#host.start(project, sceneId, this.#initialRevision);
  }

  async stop(): Promise<void> {
    this.#currentSceneId = undefined;
    await this.#host.stop();

    if (this.#closeOnStop && typeof this.#host.close === "function") {
      await this.#host.close();
    }
  }

  async close(): Promise<void> {
    this.#currentSceneId = undefined;
    try {
      await this.#host.stop();
    } catch {
      // Ignore errors during stopping if already closed
    }

    if (typeof this.#host.close === "function") {
      await this.#host.close();
    }
  }

  async input(event: RuntimeInput): Promise<void> {
    await this.#host.injectInput({
      action: event.action,
      phase: event.phase,
      ...(event.value !== undefined ? { value: event.value } : {}),
      ...(event.durationMs !== undefined
        ? { durationMs: event.durationMs }
        : {}),
    });
  }

  async wait(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async step(steps?: number, deltaSeconds?: number): Promise<void> {
    if (typeof this.#host.step === "function") {
      await this.#host.step(steps, deltaSeconds);
    } else {
      const ms = Math.round((steps ?? 1) * (deltaSeconds ?? 1 / 60) * 1000);
      await this.wait(ms);
    }
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    const query = await this.#host.query();
    const byEntityId: Record<string, unknown> = {};
    const byName: Record<string, unknown> = {};

    for (const entity of query.entities) {
      byEntityId[entity.entityId] = entity;
      byName[entity.name] = entity;
    }

    const sceneId = query.sceneId ?? this.#currentSceneId;

    return {
      running: query.running,
      ...(sceneId !== undefined ? { sceneId } : {}),
      state: {
        ...(query.projectRevision !== undefined
          ? { projectRevision: query.projectRevision }
          : {}),
        entities: query.entities,
        byEntityId,
        byName,
      },
    };
  }

  async logs(): Promise<RuntimeLog[]> {
    const entries = await this.#host.readLogs(0);
    return entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      ...(entry.data ? { data: entry.data } : {}),
    }));
  }

  async captureFrame(): Promise<Uint8Array> {
    const capture = await this.#host.captureFrame();
    if (!capture.available || !capture.base64) {
      throw new Error(
        capture.reason ?? "Runtime frame capture is unavailable",
      );
    }
    return Uint8Array.from(Buffer.from(capture.base64, "base64"));
  }

  async metrics(): Promise<RuntimeMetrics> {
    // Real runtime metrics are not yet tracked by the player.
    // Return empty metrics truthfully per architectural rule.
    return {};
  }
}
