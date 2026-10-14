import type { ProjectDocument } from "@kinetra/project-model";

import type {
  ReloadAssetResult,
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

type HostMethodName =
  | "registerAsset"
  | "updateAsset"
  | "bakeNavigation"
  | "loadNavigation"
  | "closestPointNavigation"
  | "computePathNavigation"
  | "playAnimation"
  | "registerAnimationClip"
  | "stopAnimation"
  | "playAudio"
  | "stopAudio"
  | "setAudioBusGain"
  | "setAudioBusMuted"
  | "pause"
  | "resume"
  | "detachModel"
  | "attachModel";

type HostArgs<K extends HostMethodName> = Parameters<NonNullable<RuntimeProbeHost[K]>>;

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
  #currentSceneId: string | undefined;

  constructor(options: KinetraRuntimeProbeOptions) {
    this.#host = options.host;
    this.#project = options.project;
    this.#initialRevision = options.initialRevision ?? 0;
    this.#closeOnStop = options.closeOnStop ?? false;
    this.#assets = options.assets;
    this.#assetMetadata = options.assetMetadata;
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
      },
    );
  }

  /**
   * Resolve an optional host capability or fail loudly. A host that cannot perform an action must
   * not make the acceptance step succeed: silently skipping `playAnimation`, `pause`, a navigation
   * bake and friends turned a missing capability into a false pass.
   */
  #requireHost<K extends HostMethodName>(name: K): (...args: HostArgs<K>) => Promise<unknown> {
    const method = this.#host[name] as unknown;
    if (typeof method !== "function") {
      throw new Error(`Host does not support ${name}`);
    }
    return (...args: HostArgs<K>) => (method as (...a: unknown[]) => Promise<unknown>).apply(this.#host, args);
  }

  async registerAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void> {
    await this.#requireHost("registerAsset")(assetId, dataBase64, options);
  }

  async updateAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void> {
    await this.#requireHost("updateAsset")(assetId, dataBase64, options);
  }

  async reloadAsset(assetId: string): Promise<ReloadAssetResult> {
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
    await this.#requireHost("bakeNavigation")(params);
  }

  async loadNavigation(params: { dataBase64: string }): Promise<void> {
    await this.#requireHost("loadNavigation")(params);
  }

  async closestPointNavigation(params: {
    position: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<void> {
    await this.#requireHost("closestPointNavigation")(params);
  }

  async computePathNavigation(params: {
    start: [number, number, number];
    end: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<void> {
    await this.#requireHost("computePathNavigation")(params);
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
    await this.#requireHost("playAnimation")(entityId, clip, options);
  }

  async registerAnimationClip(
    entityId: string,
    clip: unknown,
  ): Promise<void> {
    await this.#requireHost("registerAnimationClip")(entityId, clip);
  }

  async stopAnimation(entityId: string): Promise<void> {
    await this.#requireHost("stopAnimation")(entityId);
  }

  async playAudio(params: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<void> {
    await this.#requireHost("playAudio")(params);
  }

  async stopAudio(params?: { playbackId?: string; entityId?: string }): Promise<void> {
    await this.#requireHost("stopAudio")(params);
  }

  async setAudioBusGain(busId: string, gain: number): Promise<void> {
    await this.#requireHost("setAudioBusGain")(busId, gain);
  }

  async setAudioBusMuted(busId: string, muted: boolean): Promise<void> {
    await this.#requireHost("setAudioBusMuted")(busId, muted);
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
    await this.#requireHost("pause")();
  }

  async resume(): Promise<void> {
    await this.#requireHost("resume")();
  }

  async detachModel(entityId: string): Promise<unknown> {
    return this.#requireHost("detachModel")(entityId);
  }

  async attachModel(entityId: string, assetId: string): Promise<unknown> {
    return this.#requireHost("attachModel")(entityId, assetId);
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
