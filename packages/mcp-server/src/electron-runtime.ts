import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import type { ProjectDocument } from "@kinetra/project-model";

import type {
  RuntimeFrameCapture,
  RuntimeHost,
  RuntimeInputEvent,
  RuntimeLogEntry,
  RuntimeQuery,
  RuntimeQueryResult,
} from "./runtime.js";

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
}

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
  const require = createRequire(import.meta.url);
  return require("electron") as string;
}

function defaultPlayerEntry(): string {
  return resolve(findRepositoryRoot(), "apps/player/dist/package");
}

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

  #child: ChildProcessWithoutNullStreams | undefined;
  #server: Server | undefined;
  #socket: Socket | undefined;
  #pipePath: string | undefined;
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
    options?: { loop?: boolean },
  ): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("animation.play", {
      entityId,
      clip,
      ...(options?.loop !== undefined ? { loop: options.loop } : {}),
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

    // Runtime stop is polite, but teardown must never be hostage to a broken renderer.
    if (child && socket && !socket.destroyed) {
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
        child.kill();
      }

      child.unref();
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

    const electronEnv: NodeJS.ProcessEnv = {
      ...process.env,
      KINETRA_RUNTIME_BRIDGE_PIPE: pipePath,
      ...(this.saveDir ? { KINETRA_SAVE_DIR: this.saveDir } : {}),
    };

    delete electronEnv["ELECTRON_RUN_AS_NODE"];

    const executable = this.runtimeExecutable ?? this.electronExecutable;
    const args = this.runtimeExecutable
      ? (this.saveDir ? [`--save-dir=${this.saveDir}`] : [])
      : [
          this.playerEntry,
          ...(this.saveDir ? [`--save-dir=${this.saveDir}`] : []),
        ];

    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: electronEnv,
    });

    this.#child = child;

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

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        process.stderr.write(`[kinetra-electron:stdout] ${text}\n`);
      }
    });

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

    await this.#readyPromise;
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

    const socket = this.#socket;

    if (!socket || socket.destroyed) {
      throw new Error("Electron runtime bridge socket is unavailable");
    }

    const id = `host_${this.#nextRequestId++}`;

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

    socket.write(
      `${JSON.stringify({
        id,
        method,
        params,
      })}\n`,
      "utf8",
    );

    return (await response) as T;
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
