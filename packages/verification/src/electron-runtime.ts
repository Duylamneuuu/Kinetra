import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import type { ProjectDocument } from "@kinetra/project-model";
import type { RuntimePerformanceEvidence } from "./performance.js";

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
  model?: {
    assetId: string;
    loaded: boolean;
    meshCount: number;
    nodeCount: number;
    skinnedMeshCount?: number;
    hasSkin?: boolean;
    bounds?: {
      min: [number, number, number];
      max: [number, number, number];
      size: [number, number, number];
    };
    animation?: {
      clips: Array<{ name: string; duration: number }>;
      activeClip?: string;
      playing: boolean;
      time: number;
      duration?: number;
      retargetSource?: string;
      retargetCacheKey?: string;
      graph?: {
        state: string;
        previousState?: string;
        transitionId?: string;
        transitioning: boolean;
        blendSeconds?: number;
        blendElapsed?: number;
        blendProgress?: number;
      };
      actions?: Array<{
        clip: string;
        weight: number;
        role: "active" | "outgoing" | "incoming" | "blend";
      }>;
      blendSpace?: {
        id: string;
        kind: "1d" | "2d";
        parameters: string[];
        input: Record<string, number>;
        weights: Array<{ clip: string; weight: number }>;
        phase: number;
        cycleDuration: number;
        speed: number;
        groupWeight: number;
        dominantClip: string;
      };
      rootMotion?: {
        enabled: boolean;
        mode: string;
        activeClip?: string;
        accumulatedDistance: number;
        requestedDelta: [number, number, number];
        appliedDelta: [number, number, number];
        blockedDelta: [number, number, number];
        collisionClipped: boolean;
      };
    };
    nodes?: Array<{
      name: string;
      position: [number, number, number];
      rotation?: [number, number, number, number];
      scale?: [number, number, number];
    }>;
    morphTargets?: {
      targets: Array<{ name: string; weight: number; meshes: string[]; overridden: boolean }>;
      overrides: Record<string, number>;
    };
    instance?: {
      assetId: string;
      instanceId: string;
      sharedTemplateId: string;
      skinnedMeshCount: number;
      skeletonCount: number;
      fingerprint?: string;
      templateRevision?: number;
    };
    resourceSharing?: {
      templateRefCount: number;
    };
    assetFingerprint?: string;
    templateRevision?: number;
    error?: string;
  };
  gameplay?: {
    scriptId: string;
    lifecycleState: string;
    updateCount: number;
    state?: Record<string, unknown>;
    rootMotion?: {
      enabled: boolean;
      mode: string;
      activeClip?: string;
      accumulatedDistance: number;
      requestedDelta: [number, number, number];
      appliedDelta: [number, number, number];
      blockedDelta: [number, number, number];
      collisionClipped: boolean;
    };
    error?: string;
  };
}

export interface RuntimeQuery {
  entityIds?: string[];
}

export interface RuntimeQueryResult {
  running: boolean;
  sceneId?: string;
  projectRevision?: number;
  entities: RuntimeEntityState[];
  state?: Record<string, unknown>;
  shell?: { mode: string; isPaused: boolean };
  metrics?: Record<string, number>;
  renderer?: {
    captureMode: "performance" | "visual";
    preserveDrawingBuffer: boolean;
  };
  assets?: {
    byId: Record<
      string,
      {
        assetId: string;
        sourceHash?: string;
        fingerprint?: string;
        importStatus: string;
        revision?: number;
        dependentIds?: string[];
        error?: string;
      }
    >;
  };
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
  start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
    assets?: Record<string, string>,
  ): Promise<void>;
  stop(): Promise<void>;
  query(query?: RuntimeQuery): Promise<RuntimeQueryResult>;
  injectInput(event: RuntimeInputEvent): Promise<void>;
  captureFrame(): Promise<RuntimeFrameCapture>;
  readLogs(sinceSequence?: number): Promise<RuntimeLogEntry[]>;
}

interface BridgeResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ElectronRuntimeHostOptions {
  electronExecutable?: string;
  playerEntry?: string;
  runtimeExecutable?: string | undefined;
  requestTimeoutMs?: number;
  saveDir?: string;
  userDataDir?: string;
  /**
   * Runtime bridge transport.
   *
   * - `"pipe"` (default): named pipe / unix socket bridge. Unchanged
   *   Windows behavior; existing tests and packaged-exe flows use this.
   * - `"stdio"`: line-delimited JSON over the child process stdio streams
   *   (`KINETRA_RUNTIME_BRIDGE_STDIO=1`). Used by Linux cloud verification
   *   where a cross-platform stdio bridge is simpler than socket files.
   */
  transport?: ElectronRuntimeTransport;
  /**
   * Extra argv entries passed to Electron ahead of the player entry point
   * (Chromium/Electron switches such as `--no-sandbox`). Empty by default,
   * and forwarded by both the pipe and stdio transports. Linux verification
   * tests pass software-rendering switches here. Windows flows and the
   * default host pass nothing and are unaffected.
   */
  electronArgs?: string[];
  /**
   * Renderer capture mode.
   * - `"performance"` (default): normal shipping renderer configuration (`preserveDrawingBuffer: false`).
   * - `"visual"`: verification capture configuration (`preserveDrawingBuffer: true`).
   */
  captureMode?: "performance" | "visual";
}

export type ElectronRuntimeTransport = "pipe" | "stdio";

function findRepositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function defaultElectronExecutable(): string {
  try {
    const require = createRequire(import.meta.url);
    return require("electron") as string;
  } catch {
    const rootRequire = createRequire(join(findRepositoryRoot(), "package.json"));
    return rootRequire("electron") as string;
  }
}

function defaultPlayerEntry(): string {
  return resolve(findRepositoryRoot(), "apps/player/dist/package");
}

export const LINUX_ELECTRON_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--enable-unsafe-swiftshader",
] as const;

function runtimePipePath(): string {
  const id = `kinetra-runtime-${process.pid}-${randomUUID()}`;

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${id}`;
  }

  return join(tmpdir(), `${id}.sock`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ElectronRuntimeHost implements RuntimeHost {
  readonly electronExecutable: string;
  readonly playerEntry: string;
  readonly runtimeExecutable: string | undefined;
  readonly requestTimeoutMs: number;
  readonly saveDir: string | undefined;
  readonly userDataDir: string | undefined;
  readonly transport: ElectronRuntimeTransport;
  readonly electronArgs: readonly string[];
  readonly captureMode: "performance" | "visual";

  #child: ChildProcessWithoutNullStreams | undefined;
  #server: Server | undefined;
  #socket: Socket | undefined;
  #stdioLines: ReturnType<typeof createInterface> | undefined;
  #pipePath: string | undefined;
  #ownedUserDataDir: string | undefined;
  #pending = new Map<string, PendingRequest>();
  #nextRequestId = 1;
  #readyPromise: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: Error) => void) | undefined;

  constructor(options: ElectronRuntimeHostOptions = {}) {
    this.electronExecutable =
      options.electronExecutable ?? defaultElectronExecutable();

    this.playerEntry =
      options.playerEntry ?? defaultPlayerEntry();

    this.runtimeExecutable =
      "runtimeExecutable" in options
        ? options.runtimeExecutable
        : process.env.KINETRA_RUNTIME_EXECUTABLE;

    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.saveDir = options.saveDir;
    this.userDataDir = options.userDataDir;
    this.transport = options.transport ?? "pipe";
    this.electronArgs = Object.freeze([...(options.electronArgs ?? [])]);
    this.captureMode = options.captureMode === "visual" ? "visual" : "performance";
  }

  async start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
    assets?: Record<string, string>,
    options?: {
      assetMetadata?: Record<string, { fingerprint?: string; sourceHash?: string }>;
      stepped?: boolean;
    },
  ): Promise<void> {
    await this.#ensureProcess();
    await this.#request("runtime.start", {
      project,
      sceneId,
      projectRevision,
      ...(assets !== undefined ? { assets } : {}),
      ...(options?.assetMetadata !== undefined ? { assetMetadata: options.assetMetadata } : {}),
      ...(options?.stepped !== undefined ? { stepped: options.stepped } : {}),
    });
  }

  async registerAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void> {
    await this.#ensureProcess();
    await this.#request("asset.register", {
      assetId,
      dataBase64,
      ...(options?.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options?.sourceHash ? { sourceHash: options.sourceHash } : {}),
    });
  }

  async stop(): Promise<void> {
    if (!this.#child) {
      return;
    }

    await this.#request("runtime.stop", {});
  }

  async query(query: RuntimeQuery = {}): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("runtime.query", query);
  }

  async pause(): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("runtime.pause", {});
  }

  async resume(): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("runtime.resume", {});
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    await this.#ensureProcess();
    return this.#request<T>(method, params);
  }

  async injectInput(event: RuntimeInputEvent): Promise<void> {
    await this.#ensureProcess();
    await this.#request("runtime.injectInput", event);
  }

  async step(steps = 1, deltaSeconds = 1 / 60): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("runtime.step", {
      steps,
      deltaSeconds,
    });
  }

  async playAnimation(
    entityId: string,
    clip: string,
    options?: {
      loop?: boolean;
      retargetSource?: string;
      retargetCacheKey?: string;
    },
  ): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("animation.play", {
      entityId,
      clip,
      ...(options?.loop !== undefined ? { loop: options.loop } : {}),
      ...(options?.retargetSource !== undefined ? { retargetSource: options.retargetSource } : {}),
      ...(options?.retargetCacheKey !== undefined ? { retargetCacheKey: options.retargetCacheKey } : {}),
    });
  }

  async crossfadeAnimation(
    entityId: string,
    clip: string,
    blendSeconds = 0.15,
    options?: {
      loop?: boolean;
      speed?: number;
    },
  ): Promise<RuntimeQueryResult & { success: boolean; error?: string }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { success: boolean; error?: string }>(
      "animation.crossfade",
      {
        entityId,
        clip,
        blendSeconds,
        ...(options?.loop !== undefined ? { loop: options.loop } : {}),
        ...(options?.speed !== undefined ? { speed: options.speed } : {}),
      },
    );
  }

  async playBlendSpace(
    entityId: string,
    blendSpace: unknown,
    options?: { input?: Record<string, number>; speed?: number },
  ): Promise<RuntimeQueryResult & { success: boolean; code?: string; error?: string }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { success: boolean; code?: string; error?: string }>(
      "animation.blendSpace.play",
      {
        entityId,
        blendSpace,
        ...(options?.input !== undefined ? { input: options.input } : {}),
        ...(options?.speed !== undefined ? { speed: options.speed } : {}),
      },
    );
  }

  async setBlendSpaceInput(
    entityId: string,
    input: Record<string, number>,
  ): Promise<RuntimeQueryResult & { success: boolean; code?: string; error?: string }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { success: boolean; code?: string; error?: string }>(
      "animation.blendSpace.setInput",
      { entityId, input },
    );
  }

  async initAnimationGraph(
    entityId: string,
    graph: unknown,
  ): Promise<RuntimeQueryResult & { success: boolean; error?: string }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { success: boolean; error?: string }>(
      "animation.graph.init",
      {
        entityId,
        graph,
      },
    );
  }

  async setAnimationGraphParameter(
    entityId: string,
    name: string,
    value: boolean | number,
  ): Promise<RuntimeQueryResult & { success: boolean; error?: string }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { success: boolean; error?: string }>(
      "animation.graph.setParameter",
      {
        entityId,
        name,
        value,
      },
    );
  }

  async triggerAnimationGraph(
    entityId: string,
    name: string,
  ): Promise<RuntimeQueryResult & { success: boolean; error?: string }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { success: boolean; error?: string }>(
      "animation.graph.trigger",
      {
        entityId,
        name,
      },
    );
  }

  async evaluateAnimationGraph(
    entityId: string,
  ): Promise<RuntimeQueryResult & { transition?: unknown }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { transition?: unknown }>(
      "animation.graph.evaluate",
      {
        entityId,
      },
    );
  }

  async registerAnimationClip(
    entityId: string,
    clip: unknown,
  ): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("animation.registerClip", {
      entityId,
      clip,
    });
  }

  async setMorphWeights(
    entityId: string,
    weights: Record<string, number>,
  ): Promise<
    RuntimeQueryResult & {
      success: boolean;
      error?: string;
      diagnostics?: Array<{ code: string; message: string; remediation: string }>;
    }
  > {
    await this.#ensureProcess();
    return this.#request("animation.setMorphWeights", { entityId, weights });
  }

  async clearMorphWeights(
    entityId: string,
    names?: string[],
  ): Promise<
    RuntimeQueryResult & {
      success: boolean;
      cleared?: string[];
      error?: string;
      diagnostics?: Array<{ code: string; message: string; remediation: string }>;
    }
  > {
    await this.#ensureProcess();
    return this.#request("animation.clearMorphWeights", {
      entityId,
      ...(names !== undefined ? { names } : {}),
    });
  }

  async setIkChains(
    entityId: string,
    chains: unknown[],
  ): Promise<
    RuntimeQueryResult & {
      success: boolean;
      registered?: string[];
      error?: string;
      diagnostics?: Array<{ code: string; message: string; remediation: string }>;
    }
  > {
    await this.#ensureProcess();
    return this.#request("animation.ik.setChains", { entityId, chains });
  }

  async setIkTarget(
    entityId: string,
    chainId: string,
    target: [number, number, number],
    options: { pole?: [number, number, number]; weight?: number } = {},
  ): Promise<
    RuntimeQueryResult & {
      success: boolean;
      error?: string;
      diagnostics?: Array<{ code: string; message: string; remediation: string }>;
    }
  > {
    await this.#ensureProcess();
    return this.#request("animation.ik.setTarget", { entityId, chainId, target, ...options });
  }

  async clearIkTarget(entityId: string, chainId?: string): Promise<RuntimeQueryResult & { success: boolean }> {
    await this.#ensureProcess();
    return this.#request("animation.ik.clearTarget", { entityId, ...(chainId !== undefined ? { chainId } : {}) });
  }

  async stopAnimation(entityId: string): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("animation.stop", { entityId });
  }

  async configureRootMotion(params: {
    entityId: string;
    enabled: boolean;
    mode?: import("@kinetra/animation").RootMotionMode;
    rootBoneName?: string;
  }): Promise<RuntimeQueryResult & { success: boolean; diagnostics?: unknown; error?: string }> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult & { success: boolean; diagnostics?: unknown; error?: string }>(
      "animation.rootMotion.configure",
      params,
    );
  }

  async playAudio(params: {
    assetId: string;
    bus?: string;
    loop?: boolean;
    gain?: number;
    entityId?: string;
  }): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("audio.play", params);
  }

  async stopAudio(params: {
    playbackId?: string;
    entityId?: string;
  } = {}): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("audio.stop", params);
  }

  async setAudioBusGain(
    busId: string,
    gain: number,
  ): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("audio.setBusGain", {
      busId,
      gain,
    });
  }

  async setAudioBusMuted(
    busId: string,
    muted: boolean,
  ): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("audio.setBusMuted", {
      busId,
      muted,
    });
  }

  async bakeNavigation(params: {
    positions?: number[];
    indices?: number[];
    config?: Record<string, unknown>;
  }): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("navigation.bake", params);
  }

  async loadNavigation(params: {
    dataBase64: string;
  }): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("navigation.load", params);
  }

  async closestPointNavigation(params: {
    position: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("navigation.closestPoint", params);
  }

  async computePathNavigation(params: {
    start: [number, number, number];
    end: [number, number, number];
    halfExtents?: [number, number, number];
  }): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("navigation.computePath", params);
  }

  async captureFrame(): Promise<RuntimeFrameCapture> {
    await this.#ensureProcess();
    return this.#request<RuntimeFrameCapture>("runtime.captureFrame", {});
  }

  async readLogs(sinceSequence = 0): Promise<RuntimeLogEntry[]> {
    await this.#ensureProcess();
    return this.#request<RuntimeLogEntry[]>("runtime.readLogs", {
      sinceSequence,
    });
  }

  async captureSave(slotId?: string): Promise<{
    success: boolean;
    envelope?: Record<string, unknown>;
    error?: string;
  }> {
    await this.#ensureProcess();
    return this.#request<{
      success: boolean;
      envelope?: Record<string, unknown>;
      error?: string;
    }>("save.capture", { ...(slotId !== undefined ? { slotId } : {}) });
  }

  async getSave(slotId?: string): Promise<{
    success: boolean;
    envelope?: Record<string, unknown>;
    error?: string;
  }> {
    await this.#ensureProcess();
    return this.#request<{
      success: boolean;
      envelope?: Record<string, unknown>;
      error?: string;
    }>("save.get", { ...(slotId !== undefined ? { slotId } : {}) });
  }

  async loadSave(params: {
    slotId?: string;
    envelope?: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    slotId?: string;
    schemaVersion?: number;
    error?: string;
    phase?: "validation" | "migration" | "preparation" | "commit" | "rollback";
    rolledBack?: boolean;
    atomicityViolation?: boolean;
  }> {
    await this.#ensureProcess();
    return this.#request<{
      success: boolean;
      slotId?: string;
      schemaVersion?: number;
      error?: string;
      phase?: "validation" | "migration" | "preparation" | "commit" | "rollback";
      rolledBack?: boolean;
      atomicityViolation?: boolean;
    }>("save.load", params);
  }

  async enableTestScriptFixtures(preset: string): Promise<void> {
    await this.#ensureProcess();
    await this.#request("testHarness.enableTestFixtures", { preset });
  }

  async detachModel(entityId: string): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("model.detach", { entityId });
  }

  async attachModel(entityId: string, assetId: string): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("model.attach", { entityId, assetId });
  }

  async reloadAsset(
    assetId: string,
  ): Promise<{ success: boolean; affectedEntities: string[]; error?: string }> {
    await this.#ensureProcess();
    return this.#request<{ success: boolean; affectedEntities: string[]; error?: string }>(
      "model.reloadAsset",
      { assetId },
    );
  }

  async updateAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<void> {
    await this.#ensureProcess();
    await this.#request("asset.update", {
      assetId,
      dataBase64,
      ...(options?.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options?.sourceHash ? { sourceHash: options.sourceHash } : {}),
    });
  }


  getResolvedExecutable(): string {
    return this.runtimeExecutable ?? this.electronExecutable;
  }

  isPackagedTarget(): boolean {
    return this.runtimeExecutable !== undefined;
  }

  async getHostInfo(): Promise<{
    isPackaged: boolean;
    execPath: string;
    platform: string;
    arch: string;
    captureMode?: "performance" | "visual";
    preserveDrawingBuffer?: boolean;
  }> {
    await this.#ensureProcess();
    return this.#request("runtime.hostInfo", {});
  }

  async samplePerformance(options?: {
    warmupFrames?: number;
    sampleFrames?: number;
    fixedDeltaSeconds?: number;
    mode?: "stepped" | "continuous";
  }): Promise<RuntimePerformanceEvidence> {
    await this.#ensureProcess();
    return this.#request<RuntimePerformanceEvidence>("performance.sample", options ?? {});
  }

  /**
   * Tear the bridge down. Concurrent calls share one teardown, and requests that arrive while it
   * runs wait for it to finish before they launch a replacement process: the teardown's last
   * steps reset the process fields, which would otherwise wipe out the replacement's state and
   * orphan it. A request that arrives mid-teardown therefore starts a fresh bridge after the
   * teardown, and nothing closes that bridge unless the caller calls `close()` again: do not treat
   * one `close()` as the final cleanup while other callers can still issue requests. Callers that
   * were waiting for the bridge to become ready when `close()` ran fail with "Electron runtime
   * bridge closed" instead of waiting for the request timeout.
   */
  close(): Promise<void> {
    if (!this.#closing) {
      const closing = this.#closeNow().finally(() => {
        if (this.#closing === closing) {
          this.#closing = undefined;
        }
      });
      this.#closing = closing;
    }
    return this.#closing;
  }

  async #closeNow(): Promise<void> {
    const child = this.#child;
    const socket = this.#socket;
    const server = this.#server;
    const stdioLines = this.#stdioLines;

    // A startup still waiting for the "ready" signal would otherwise hang until its timeout
    // (close() releases the process, so its exit handler no longer fires) and keep the shared
    // `#starting` promise alive, so a request issued after close() would join that dead startup
    // instead of launching a fresh bridge. A no-op once the bridge is ready.
    this.#rejectReady?.(new Error("Electron runtime bridge closed while starting"));

    const bridgeWritable =
      this.transport === "stdio"
        ? Boolean(child && !child.stdin.destroyed)
        : Boolean(socket && !socket.destroyed);

    // Runtime stop is polite, but teardown must never be hostage to a broken renderer.
    if (child && bridgeWritable) {
      try {
        await Promise.race([
          this.#request("runtime.stop", {}),
          new Promise<void>((resolveTimeout) =>
            setTimeout(resolveTimeout, 1_000),
          ),
        ]);
      } catch {
        // Hard teardown below is authoritative.
      }
    }

    this.#socket = undefined;
    socket?.destroy();

    this.#stdioLines = undefined;
    stdioLines?.close();

    this.#server = undefined;
    if (server) {
      server.close();
      server.unref();
    }

    this.#child = undefined;
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();

      if (!child.killed) {
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
          } else if (process.platform === "linux" && child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        } catch {
          // ignore
        }
        child.kill();
      }

      child.unref();

      // Bounded wait so repeated invocations cannot leak Electron processes.
      // The process was already signalled above; this only escalates if it
      // refuses to exit.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = await Promise.race([
          new Promise<boolean>((resolveExit) => {
            child.once("exit", () => resolveExit(true));
            if (child.exitCode !== null || child.signalCode !== null) {
              resolveExit(true);
            }
          }),
          new Promise<boolean>((resolveTimeout) =>
            setTimeout(() => resolveTimeout(false), 5_000),
          ),
        ]);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }
    }

    if (this.#ownedUserDataDir) {
      const dirToRemove = this.#ownedUserDataDir;
      this.#ownedUserDataDir = undefined;
      try {
        rmSync(dirToRemove, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    this.#readyPromise = undefined;
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;

    this.#rejectAllPending(new Error("Electron runtime bridge closed"));
  }

  async #ensureProcess(): Promise<void> {
    if (this.#child && this.#readyPromise) {
      await this.#readyPromise;
      return;
    }

    // A teardown in flight owns the process fields until it ends; launching now would have it
    // reset (and orphan) the new process.
    while (this.#closing) {
      await this.#closing.catch(() => undefined);
    }
    if (this.#child && this.#readyPromise) {
      await this.#readyPromise;
      return;
    }

    // The pipe transport awaits `server.listen` before it spawns the child, so a second caller
    // arriving in that window would start a second server and process, orphaning the first.
    // All concurrent first callers share one in-flight startup instead.
    if (!this.#starting) {
      const starting = (
        this.transport === "stdio"
          ? this.#ensureStdioProcess()
          : this.#ensurePipeProcess()
      ).finally(() => {
        if (this.#starting === starting) {
          this.#starting = undefined;
        }
      });
      this.#starting = starting;
    }

    await this.#starting;
  }

  async #ensurePipeProcess(): Promise<void> {
    const pipePath = runtimePipePath();
    this.#pipePath = pipePath;

    const server = createServer((socket) => {
      if (this.#socket) {
        socket.destroy(new Error("Kinetra runtime bridge accepts one connection"));
        return;
      }

      this.#socket = socket;
      socket.on("error", (error) => this.#handleTransportError("socket", error));

      const output = createInterface({
        input: socket,
        crlfDelay: Infinity,
      });

      output.on("line", (line) => this.#handleBridgeLine(line));

      socket.once("close", () => {
        if (this.#socket === socket) {
          this.#socket = undefined;
        }
      });
    });

    this.#server = server;

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      // close() while still binding must not leave the startup waiting for a "listening" that
      // never comes.
      server.once("close", () => rejectListen(new Error("Electron runtime bridge closed while starting")));
      server.listen(pipePath, resolveListen);
    });

    if (this.#server !== server) {
      // close() ran while the server was still binding: do not launch a process nobody owns.
      server.close();
      server.unref();
      throw new Error("Electron runtime bridge closed while starting");
    }

    const effectiveUserDataDir = this.#claimUserDataDir();

    const electronEnv: NodeJS.ProcessEnv = {
      ...process.env,
      KINETRA_RUNTIME_BRIDGE_PIPE: pipePath,
      KINETRA_USER_DATA_DIR: effectiveUserDataDir,
      ...(this.saveDir ? { KINETRA_SAVE_DIR: this.saveDir } : {}),
      KINETRA_CAPTURE_MODE: this.captureMode,
    };

    delete electronEnv["ELECTRON_RUN_AS_NODE"];

    if (process.platform === "linux") {
      electronEnv.KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW = "1";
    }

    const executable = this.runtimeExecutable ?? this.electronExecutable;
    const platformArgs = this.#platformLaunchArgs();
    const args = this.runtimeExecutable
      ? [
          ...this.electronArgs,
          ...platformArgs,
          ...this.#appArgs(effectiveUserDataDir),
        ]
      : [
          ...this.electronArgs,
          this.playerEntry,
          ...platformArgs,
          ...this.#appArgs(effectiveUserDataDir),
        ];

    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: electronEnv,
      detached: process.platform === "linux",
    });

    this.#child = child;
    child.stdin.on("error", (error) => this.#handleTransportError("stdin", error));
    this.#armReadyPromise();

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        process.stderr.write(`[kinetra-electron:stdout] ${text}\n`);
      }
    });

    this.#watchChild(child);

    await this.#readyPromise;
  }

  async #ensureStdioProcess(): Promise<void> {
    const effectiveUserDataDir = this.#claimUserDataDir();

    const electronEnv: NodeJS.ProcessEnv = {
      ...process.env,
      KINETRA_RUNTIME_BRIDGE_STDIO: "1",
      KINETRA_USER_DATA_DIR: effectiveUserDataDir,
      ...(this.saveDir ? { KINETRA_SAVE_DIR: this.saveDir } : {}),
      KINETRA_CAPTURE_MODE: this.captureMode,
    };

    delete electronEnv["ELECTRON_RUN_AS_NODE"];
    delete electronEnv["KINETRA_RUNTIME_BRIDGE_PIPE"];

    if (process.platform === "linux") {
      electronEnv.KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW = "1";
    }

    const executable = this.runtimeExecutable ?? this.electronExecutable;
    const platformArgs = this.#platformLaunchArgs();
    const args = this.runtimeExecutable
      ? [
          ...this.electronArgs,
          ...platformArgs,
          ...this.#appArgs(effectiveUserDataDir),
        ]
      : [
          ...this.electronArgs,
          this.playerEntry,
          ...platformArgs,
          ...this.#appArgs(effectiveUserDataDir),
        ];

    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: electronEnv,
      detached: process.platform === "linux",
    });

    this.#child = child;
    child.stdin.on("error", (error) => this.#handleTransportError("stdin", error));

    const output = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.#stdioLines = output;
    output.on("line", (line) => this.#handleStdioLine(line));

    this.#armReadyPromise();
    this.#watchChild(child);

    await this.#readyPromise;
  }

  #claimUserDataDir(): string {
    const effectiveUserDataDir =
      this.userDataDir ?? join(tmpdir(), `kinetra-ud-${randomUUID()}`);
    if (!this.userDataDir) {
      this.#ownedUserDataDir = effectiveUserDataDir;
    }
    return effectiveUserDataDir;
  }

  #appArgs(effectiveUserDataDir: string): string[] {
    return [
      ...(this.saveDir ? [`--save-dir=${this.saveDir}`] : []),
      `--user-data-dir=${effectiveUserDataDir}`,
      `--capture-mode=${this.captureMode}`,
    ];
  }

  #platformLaunchArgs(): string[] {
    return process.platform === "linux" ? [...LINUX_ELECTRON_LAUNCH_ARGS] : [];
  }

  #armReadyPromise(): void {
    this.#readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(
          new Error(
            `Timed out waiting for Electron runtime bridge ready signal after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);

      this.#resolveReady = () => {
        clearTimeout(timer);
        resolveReady();
      };
      this.#rejectReady = (err) => {
        clearTimeout(timer);
        rejectReady(err);
      };
    });
  }

  #watchChild(child: ChildProcessWithoutNullStreams): void {
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        process.stderr.write(`[kinetra-electron] ${text}\n`);
      }
    });

    // A process that is no longer current (close() released it, or a replacement was launched)
    // can still report its error or exit late; that must not fail the replacement's startup or
    // its requests in flight.
    child.once("error", (error) => {
      if (this.#child !== child) {
        return;
      }
      this.#rejectReady?.(error);
      this.#rejectAllPending(error);
      this.#resetProcess(child);
    });

    child.once("exit", (code, signal) => {
      if (this.#child !== child) {
        return;
      }
      const error = new Error(
        `Electron runtime bridge exited (code=${String(code)}, signal=${String(signal)})`,
      );
      this.#rejectReady?.(error);
      this.#rejectAllPending(error);
      this.#resetProcess(child);
    });
  }

  #handleStdioLine(line: string): void {
    // In stdio mode the child stdout channel carries bridge messages.
    // Anything else is unexpected process chatter: surface it for diagnosis
    // instead of feeding it to the JSON bridge parser.
    if (!line.trim()) {
      return;
    }
    if (!line.trimStart().startsWith("{")) {
      process.stderr.write(`[kinetra-electron:stdout] ${line}\n`);
      return;
    }
    this.#handleBridgeLine(line);
  }

  #handleBridgeLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      process.stderr.write(`[kinetra-bridge] non-JSON: ${line}\n`);
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return;
    }

    if (parsed.type === "event" && parsed.event === "ready") {
      this.#resolveReady?.();
      return;
    }

    if (
      parsed.type !== "response" ||
      typeof parsed.id !== "string" ||
      typeof parsed.ok !== "boolean"
    ) {
      return;
    }

    const response = parsed as unknown as BridgeResponse;
    const pending = this.#pending.get(response.id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.#pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new Error(response.error ?? "Unknown Electron bridge failure"),
      );
    }
  }

  async #request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.#ensureProcess();

    const id = `host_${this.#nextRequestId++}`;
    const line = `${JSON.stringify({
      id,
      method,
      params,
    })}\n`;

    if (this.transport === "stdio") {
      const child = this.#child;
      if (!child || child.stdin.destroyed) {
        throw new Error("Electron runtime bridge stdin is unavailable");
      }
      const response = this.#trackPending<T>(id, method);
      try {
        child.stdin.write(line, "utf8");
      } catch (error) {
        this.#pending.delete(id);
        throw error;
      }
      return response;
    }

    const socket = this.#socket;

    if (!socket || socket.destroyed) {
      throw new Error("Electron runtime bridge socket is unavailable");
    }

    const response = this.#trackPending<T>(id, method);
    try {
      socket.write(line, "utf8");
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  #trackPending<T>(id: string, method: string): Promise<T> {
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `Electron runtime request "${method}" timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
    });

    return response as Promise<T>;
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.#pending.clear();
  }

  #resetProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== child) {
      return;
    }

    this.#child = undefined;
    this.#readyPromise = undefined;
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    this.#releaseTransport();
  }

  /**
   * A bridge process that exited on its own (crash, kill) used to leave its listening server,
   * socket and temp user-data directory behind: the next `#ensureProcess` overwrote the fields,
   * so the old server kept the event loop alive and the old directory was never removed.
   */
  #releaseTransport(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();

    const stdioLines = this.#stdioLines;
    this.#stdioLines = undefined;
    stdioLines?.close();

    const server = this.#server;
    this.#server = undefined;
    if (server) {
      server.close();
      server.unref();
    }

    if (this.#ownedUserDataDir) {
      const dirToRemove = this.#ownedUserDataDir;
      this.#ownedUserDataDir = undefined;
      try {
        rmSync(dirToRemove, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * A write to a bridge whose other end is gone (EPIPE/ECONNRESET) is reported asynchronously as
   * an "error" event. Without a listener that was an uncaught exception that took the host
   * process down; now the requests in flight fail fast with a descriptive error instead.
   */
  #handleTransportError(source: string, error: Error): void {
    this.#rejectAllPending(
      new Error(`Electron runtime bridge ${source} failed: ${error.message}`),
    );
  }
}

/**
 * Whether the current machine can launch real Electron for runtime tests.
 *
 * - Windows: yes (native display; existing CI behavior, unchanged).
 * - Linux: yes when an X display is available (`DISPLAY` set, e.g. under
 *   `xvfb-run`). Headless shells without X skip instead of failing.
 * - Other platforms: no (not a Kinetra test target).
 */
export function canRunRealElectronTests(): boolean {
  if (process.platform === "win32") {
    return true;
  }
  if (process.platform === "linux") {
    return Boolean(process.env.DISPLAY);
  }
  return false;
}

/**
 * Chromium switches for real Electron verification hosts on Linux CI and
 * cloud VMs. The chrome-sandbox helper there is not installed setuid, and
 * there is no GPU. Windows returns an empty list so existing CI behavior
 * stays unchanged.
 *
 * The switch list is `LINUX_ELECTRON_LAUNCH_ARGS`. `ElectronRuntimeHost`
 * already applies that list on Linux through `#platformLaunchArgs` for both
 * the dev player and the packaged executable. Tests may also pass this
 * function as `electronArgs`; that forwards the same list and does not
 * introduce a second policy. On Linux this also shows the bridge window so
 * `capturePage()` composites the WebGL canvas instead of a stale hidden DOM
 * layer. The default host constructor leaves `electronArgs` empty.
 */
export function realElectronLaunchArgs(): string[] {
  if (process.platform !== "linux") {
    return [];
  }
  process.env.KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW = "1";
  return [...LINUX_ELECTRON_LAUNCH_ARGS];
}
