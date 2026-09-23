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
  assets?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  testScriptPreset?: string;
}

export class KinetraRuntimeProbe implements RuntimeProbe {
  readonly #host: RuntimeProbeHost;
  readonly #project:
    | ProjectDocument
    | (() => ProjectDocument | Promise<ProjectDocument>);
  readonly #initialRevision: number;
  readonly #closeOnStop: boolean;
  readonly #assets:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | undefined;
  readonly #testScriptPreset: string | undefined;
  #currentSceneId: string | undefined;

  constructor(options: KinetraRuntimeProbeOptions) {
    this.#host = options.host;
    this.#project = options.project;
    this.#initialRevision = options.initialRevision ?? 0;
    this.#closeOnStop = options.closeOnStop ?? false;
    this.#assets = options.assets;
    this.#testScriptPreset = options.testScriptPreset;
  }

  async start(sceneId: string, _seed: number): Promise<void> {
    const project =
      typeof this.#project === "function"
        ? await this.#project()
        : this.#project;

    const assets =
      typeof this.#assets === "function"
        ? await this.#assets()
        : this.#assets;

    this.#currentSceneId = sceneId;
    if (
      this.#testScriptPreset &&
      typeof this.#host.enableTestScriptFixtures === "function"
    ) {
      await this.#host.enableTestScriptFixtures(this.#testScriptPreset);
    }
    await this.#host.start(
      project,
      sceneId,
      this.#initialRevision,
      assets !== undefined && Object.keys(assets).length > 0
        ? assets
        : undefined,
    );
  }

  async registerAsset(assetId: string, dataBase64: string): Promise<void> {
    if (typeof this.#host.registerAsset === "function") {
      await this.#host.registerAsset(assetId, dataBase64);
    }
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

  async bakeNavigation(params: {
    positions?: number[];
    indices?: number[];
    config?: Record<string, unknown>;
  }): Promise<void> {
    if (typeof this.#host.bakeNavigation === "function") {
      await this.#host.bakeNavigation(params);
    }
  }

  async loadNavigation(params: { dataBase64: string }): Promise<void> {
    if (typeof this.#host.loadNavigation === "function") {
      await this.#host.loadNavigation(params);
    }
  }

  async closestPointNavigation(params: {
    position: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<void> {
    if (typeof this.#host.closestPointNavigation === "function") {
      await this.#host.closestPointNavigation(params);
    }
  }

  async computePathNavigation(params: {
    start: [number, number, number];
    end: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<void> {
    if (typeof this.#host.computePathNavigation === "function") {
      await this.#host.computePathNavigation(params);
    }
  }

  async playAnimation(
    entityId: string,
    clip: string,
    options?: { loop?: boolean },
  ): Promise<void> {
    if (typeof this.#host.playAnimation === "function") {
      await this.#host.playAnimation(entityId, clip, options);
    }
  }

  async stopAnimation(entityId: string): Promise<void> {
    if (typeof this.#host.stopAnimation === "function") {
      await this.#host.stopAnimation(entityId);
    }
  }

  async playAudio(params: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<void> {
    if (typeof this.#host.playAudio === "function") {
      await this.#host.playAudio(params);
    }
  }

  async stopAudio(params?: { playbackId?: string; entityId?: string }): Promise<void> {
    if (typeof this.#host.stopAudio === "function") {
      await this.#host.stopAudio(params);
    }
  }

  async setAudioBusGain(busId: string, gain: number): Promise<void> {
    if (typeof this.#host.setAudioBusGain === "function") {
      await this.#host.setAudioBusGain(busId, gain);
    }
  }

  async setAudioBusMuted(busId: string, muted: boolean): Promise<void> {
    if (typeof this.#host.setAudioBusMuted === "function") {
      await this.#host.setAudioBusMuted(busId, muted);
    }
  }

  async captureSave(slotId?: string): Promise<{
    success: boolean;
    envelope?: Record<string, unknown>;
    error?: string;
  }> {
    if (typeof this.#host.captureSave === "function") {
      return this.#host.captureSave(slotId);
    }
    return { success: false, error: "Host does not support captureSave" };
  }

  async getSave(slotId?: string): Promise<{
    success: boolean;
    envelope?: Record<string, unknown>;
    error?: string;
  }> {
    if (typeof this.#host.getSave === "function") {
      return this.#host.getSave(slotId);
    }
    return { success: false, error: "Host does not support getSave" };
  }

  async loadSave(params: {
    slotId?: string;
    envelope?: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    slotId?: string;
    schemaVersion?: number;
    error?: string;
  }> {
    if (typeof this.#host.loadSave === "function") {
      return this.#host.loadSave(params);
    }
    return { success: false, error: "Host does not support loadSave" };
  }

  async pause(): Promise<void> {
    if (typeof this.#host.pause === "function") {
      await this.#host.pause();
    }
  }

  async resume(): Promise<void> {
    if (typeof this.#host.resume === "function") {
      await this.#host.resume();
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
      ...(query.shell !== undefined ? { shell: query.shell } : {}),
      state: {
        ...(query.projectRevision !== undefined
          ? { projectRevision: query.projectRevision }
          : {}),
        entities: query.entities,
        byEntityId,
        byName,
        ...(query.navigation ? { navigation: query.navigation } : {}),
        ...(query.audio ? { audio: query.audio } : {}),
        ...(query.gameplay ? { gameplay: query.gameplay } : {}),
        ...(query.game ? { game: query.game } : {}),
        ...(query.shell ? { shell: query.shell } : {}),
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
    if (typeof this.#host.metrics === "function") {
      return this.#host.metrics();
    }
    return {};
  }
}
