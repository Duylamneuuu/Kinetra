import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
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
  requestTimeoutMs?: number;
}

function repositoryRoot(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
}

function defaultElectronExecutable(): string {
  const require = createRequire(import.meta.url);
  return require("electron") as string;
}

function defaultPlayerEntry(): string {
  return resolve(
    repositoryRoot(),
    "apps/player/dist/electron/main.js",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ElectronRuntimeHost implements RuntimeHost {
  readonly electronExecutable: string;
  readonly playerEntry: string;
  readonly requestTimeoutMs: number;

  #child: ChildProcessWithoutNullStreams | undefined;
  #pending = new Map<string, PendingRequest>();
  #nextRequestId = 1;
  #readyPromise: Promise<void> | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: Error) => void) | undefined;

  constructor(options: ElectronRuntimeHostOptions = {}) {
    this.electronExecutable =
      options.electronExecutable ??
      process.env.KINETRA_ELECTRON_EXECUTABLE ??
      defaultElectronExecutable();

    this.playerEntry =
      options.playerEntry ??
      process.env.KINETRA_PLAYER_ENTRY ??
      defaultPlayerEntry();

    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async start(
    project: ProjectDocument,
    sceneId: string,
    projectRevision: number,
  ): Promise<void> {
    await this.#ensureProcess();
    await this.#request("runtime.start", {
      project,
      sceneId,
      projectRevision,
    });
  }

  async stop(): Promise<void> {
    if (!this.#child) {
      return;
    }

    await this.#request("runtime.stop", {});
  }

  async query(
    query: RuntimeQuery = {},
  ): Promise<RuntimeQueryResult> {
    await this.#ensureProcess();
    return this.#request<RuntimeQueryResult>("runtime.query", query);
  }

  async injectInput(event: RuntimeInputEvent): Promise<void> {
    await this.#ensureProcess();
    await this.#request("runtime.injectInput", event);
  }

  async captureFrame(): Promise<RuntimeFrameCapture> {
    await this.#ensureProcess();
    return this.#request<RuntimeFrameCapture>(
      "runtime.captureFrame",
      {},
    );
  }

  async readLogs(
    sinceSequence = 0,
  ): Promise<RuntimeLogEntry[]> {
    await this.#ensureProcess();
    return this.#request<RuntimeLogEntry[]>(
      "runtime.readLogs",
      { sinceSequence },
    );
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) {
      return;
    }

    try {
      await this.#request("runtime.stop", {});
    } catch {
      // Process teardown below is authoritative.
    }

    this.#child = undefined;
    child.stdin.end();
    child.kill();
    this.#rejectAllPending(
      new Error("Electron runtime bridge closed"),
    );
  }

  async #ensureProcess(): Promise<void> {
    if (this.#child && this.#readyPromise) {
      await this.#readyPromise;
      return;
    }

    const child = spawn(
      this.electronExecutable,
      [this.playerEntry, "--runtime-bridge-stdio"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env },
      },
    );

    this.#child = child;

    this.#readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.#resolveReady = resolveReady;
      this.#rejectReady = rejectReady;
    });

    const output = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    output.on("line", (line) => this.#handleStdoutLine(line));

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

  #handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      process.stderr.write(
        `[kinetra-electron] non-JSON stdout: ${line}\n`,
      );
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

  async #request<T = unknown>(
    method: string,
    params: unknown,
  ): Promise<T> {
    await this.#ensureProcess();

    const child = this.#child;
    if (!child) {
      throw new Error("Electron runtime bridge is unavailable");
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

    child.stdin.write(
      `${JSON.stringify({ id, method, params })}\n`,
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
