import type { ProjectDocument } from "@kinetra/project-model";

import type {
  RuntimeInput,
  RuntimeLog,
  RuntimeMetrics,
  RuntimeProbe,
  RuntimeProbeHost,
  RuntimeSnapshot,
} from "./types.js";
import type { RuntimePerformanceEvidence } from "./performance.js";

/** Largest delay setTimeout honours (2^31-1 ms); larger values fire after 1 ms. */
const MAX_WAIT_MS = 2_147_483_647;

export interface KinetraRuntimeProbeOptions {
  host: RuntimeProbeHost;
  project: ProjectDocument | (() => ProjectDocument | Promise<ProjectDocument>);
  initialRevision?: number;
  closeOnStop?: boolean;
  assets?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  assetMetadata?:
    | Record<string, { fingerprint?: string; sourceHash?: string }>
    | (() =>
        | Record<string, { fingerprint?: string; sourceHash?: string }>
        | Promise<Record<string, { fingerprint?: string; sourceHash?: string }>>);
  testScriptPreset?: string;
  /** Game module id the runtime should run (e.g. "orb-run"); the player's default game when omitted. */
  game?: string;
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
  readonly #assetMetadata:
    | Record<string, { fingerprint?: string; sourceHash?: string }>
    | (() =>
        | Record<string, { fingerprint?: string; sourceHash?: string }>
        | Promise<Record<string, { fingerprint?: string; sourceHash?: string }>>)
    | undefined;
  readonly #testScriptPreset: string | undefined;
  readonly #game: string | undefined;
  #currentSceneId: string | undefined;

  constructor(options: KinetraRuntimeProbeOptions) {
    this.#host = options.host;
    this.#project = options.project;
    this.#initialRevision = options.initialRevision ?? 0;
    this.#closeOnStop = options.closeOnStop ?? false;
    this.#assets = options.assets;
    this.#assetMetadata = options.assetMetadata;
    this.#testScriptPreset = options.testScriptPreset;
    this.#game = options.game;
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

    const assetMetadata =
      typeof this.#assetMetadata === "function"
        ? await this.#assetMetadata()
        : this.#assetMetadata;

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
      {
        ...(assetMetadata !== undefined ? { assetMetadata } : {}),
        ...(this.#game !== undefined ? { game: this.#game } : {}),
      },
    );
  }

  async registerAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void> {
    if (typeof this.#host.registerAsset === "function") {
      await this.#host.registerAsset(assetId, dataBase64, options);
    }
  }

  async updateAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void> {
    if (typeof this.#host.updateAsset === "function") {
      await this.#host.updateAsset(assetId, dataBase64, options);
    }
  }

  async reloadAsset(
    assetId: string,
  ): Promise<{ success: boolean; affectedEntities: string[]; error?: string }> {
    if (typeof this.#host.reloadAsset === "function") {
      return this.#host.reloadAsset(assetId);
    }
    return { success: false, affectedEntities: [], error: "Host does not support reloadAsset" };
  }

  async queryEntities(): Promise<Array<{ entityId: string; model?: { assetId?: string | undefined } | undefined }>> {
    const q = await this.#host.query();
    return (q.entities ?? []).map((e) => ({
      entityId: e.entityId,
      model: e.model ? { assetId: e.model.assetId } : undefined,
    }));
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
    // setTimeout coerces NaN / Infinity / anything above 2^31-1 ms to 1 ms, so a "wait" that
    // should last a long time (or is garbage) would return immediately and the step would pass.
    if (typeof milliseconds !== "number" || Number.isNaN(milliseconds)) {
      throw new RangeError(`wait: milliseconds must be a finite number, got ${String(milliseconds)}`);
    }
    if (milliseconds <= 0) {
      return;
    }
    if (milliseconds > MAX_WAIT_MS) {
      throw new RangeError(`wait: ${milliseconds}ms exceeds the maximum of ${MAX_WAIT_MS}ms`);
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
    options?: {
      loop?: boolean;
      retargetSource?: string;
      retargetCacheKey?: string;
    },
  ): Promise<void> {
    if (typeof this.#host.playAnimation === "function") {
      await this.#host.playAnimation(entityId, clip, options);
    }
  }

  async registerAnimationClip(
    entityId: string,
    clip: unknown,
  ): Promise<void> {
    if (typeof this.#host.registerAnimationClip === "function") {
      await this.#host.registerAnimationClip(entityId, clip);
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

  async detachModel(entityId: string): Promise<unknown> {
    if (typeof this.#host.detachModel === "function") {
      return this.#host.detachModel(entityId);
    }
    return undefined;
  }

  async attachModel(entityId: string, assetId: string): Promise<unknown> {
    if (typeof this.#host.attachModel === "function") {
      return this.#host.attachModel(entityId, assetId);
    }
    return undefined;
  }


  async snapshot(): Promise<RuntimeSnapshot> {
    const query = await this.#host.query();
    const byEntityId: Record<string, unknown> = {};
    const byName: Record<string, unknown> = {};

    // defineProperty (not assignment): `obj["__proto__"] = entity` would swap the index's prototype
    // instead of adding a key, so an entity named "__proto__" would be unreachable and its fields
    // would leak into the index as if they were entity names.
    const put = (index: Record<string, unknown>, key: string, entity: unknown): void => {
      Object.defineProperty(index, key, {
        value: entity,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    };
    for (const entity of query.entities) {
      put(byEntityId, entity.entityId, entity);
      put(byName, entity.name, entity);
    }

    const sceneId = query.sceneId ?? this.#currentSceneId;

    return {
      running: query.running,
      ...(sceneId !== undefined ? { sceneId } : {}),
      ...(query.shell !== undefined ? { shell: query.shell } : {}),
      ...(query.renderer !== undefined ? { renderer: query.renderer } : {}),
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
        ...(query.renderer ? { renderer: query.renderer } : {}),
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

  async samplePerformance(options?: {
    warmupFrames?: number;
    sampleFrames?: number;
    fixedDeltaSeconds?: number;
    mode?: "stepped" | "continuous";
  }): Promise<RuntimePerformanceEvidence> {
    if (typeof this.#host.samplePerformance === "function") {
      return this.#host.samplePerformance(options);
    }
    throw new Error("Runtime probe host does not support performance sampling");
  }
}
