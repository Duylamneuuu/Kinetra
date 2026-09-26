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
    };
    nodes?: Array<{
      name: string;
      position: [number, number, number];
      rotation?: [number, number, number, number];
      scale?: [number, number, number];
    }>;
    error?: string;
  };
  gameplay?: {
    scriptId: string;
    lifecycleState: string;
    updateCount: number;
    state?: Record<string, unknown>;
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

  #child: ChildProcessWithoutNullStreams | undefined;
  #server: Server | undefined;
  #socket: Socket | undefined;
  #stdioLines: ReturnType<typeof createInterface> | undefined;
  #pipePath: string | undefined;
  #ownedUserDataDir: string | undefined;
  #pending = new Map<string, PendingRequest>();
  #nextRequestId = 1;
  #readyPromise: Promise<void> | undefined;
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
  }

  async start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
    assets?: Record<string, string>,
  ): Promise<void> {
    await this.#ensureProcess();
    await this.#request("runtime.start", {
      project,
      sceneId,
      projectRevision,
      ...(assets !== undefined ? { assets } : {}),
    });
  }

  async registerAsset(assetId: string, dataBase64: string): Promise<void> {
    await this.#ensureProcess();
    await this.#request("asset.register", { assetId, dataBase64 });
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

  async stopAnimation(entityId: string): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("animation.stop", { entityId });
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
  }> {
    await this.#ensureProcess();
    return this.#request("runtime.hostInfo", {});
  }

  async close(): Promise<void> {
    const child = this.#child;
    const socket = this.#socket;
    const server = this.#server;
    const stdioLines = this.#stdioLines;

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

    if (this.transport === "stdio") {
      await this.#ensureStdioProcess();
      return;
    }

    await this.#ensurePipeProcess();
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
      server.listen(pipePath, resolveListen);
    });

    const effectiveUserDataDir = this.#claimUserDataDir();

    const electronEnv: NodeJS.ProcessEnv = {
      ...process.env,
      KINETRA_RUNTIME_BRIDGE_PIPE: pipePath,
      KINETRA_USER_DATA_DIR: effectiveUserDataDir,
      ...(this.saveDir ? { KINETRA_SAVE_DIR: this.saveDir } : {}),
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

    child.once("error", (error) => {
      this.#rejectReady?.(error);
      this.#rejectAllPending(error);
      this.#resetProcess(child);
    });

    child.once("exit", (code, signal) => {
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
