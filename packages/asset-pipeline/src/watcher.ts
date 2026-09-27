import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { hashBytes } from "./hash.js";

export interface SourceChangeEvent {
  type: "asset.changeDetected";
  assetId: string;
  sourcePath: string;
  oldContentHash?: string | undefined;
  newContentHash: string;
}

export interface SourceAssetWatcherOptions {
  debounceMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onEvent?: (event: SourceChangeEvent) => void;
}

export class SourceAssetWatcher {
  readonly #debounceMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #listeners = new Set<(event: SourceChangeEvent) => void>();

  #assets = new Map<string, string>(); // assetId -> sourcePath
  #pathToAssetId = new Map<string, string>(); // sourcePath -> assetId
  #knownHashes = new Map<string, string>(); // assetId -> contentHash
  #watchers = new Map<string, FSWatcher>(); // sourcePath -> FSWatcher
  #debounceTimers = new Map<string, NodeJS.Timeout>();
  #running = false;

  constructor(options: SourceAssetWatcherOptions = {}) {
    this.#debounceMs = options.debounceMs ?? 60;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 20;
    if (options.onEvent) {
      this.#listeners.add(options.onEvent);
    }
  }

  isWatching(): boolean {
    return this.#running;
  }

  onEvent(listener: (event: SourceChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  addAsset(assetId: string, sourcePath: string, initialHash?: string): void {
    this.#assets.set(assetId, sourcePath);
    this.#pathToAssetId.set(sourcePath, assetId);
    if (initialHash) {
      this.#knownHashes.set(assetId, initialHash);
    }

    if (this.#running) {
      this.#watchFile(sourcePath);
    }
  }

  removeAsset(assetId: string): void {
    const sourcePath = this.#assets.get(assetId);
    if (sourcePath) {
      this.#unwatchFile(sourcePath);
      this.#pathToAssetId.delete(sourcePath);
      const timer = this.#debounceTimers.get(sourcePath);
      if (timer) {
        clearTimeout(timer);
        this.#debounceTimers.delete(sourcePath);
      }
    }
    this.#assets.delete(assetId);
    this.#knownHashes.delete(assetId);
  }

  getKnownHash(assetId: string): string | undefined {
    return this.#knownHashes.get(assetId);
  }

  setKnownHash(assetId: string, hash: string): void {
    this.#knownHashes.set(assetId, hash);
  }

  getWatchedAssets(): ReadonlyMap<string, string> {
    return this.#assets;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    for (const [assetId, sourcePath] of this.#assets) {
      if (!this.#knownHashes.has(assetId)) {
        try {
          const bytes = await this.#readFileWithRetry(sourcePath);
          this.#knownHashes.set(assetId, hashBytes(bytes));
        } catch {
          // File may not exist yet; watcher will handle creation
        }
      }
      this.#watchFile(sourcePath);
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();

    for (const timer of this.#debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.#debounceTimers.clear();
  }

  #watchFile(sourcePath: string): void {
    if (this.#watchers.has(sourcePath)) return;

    try {
      const watcher = watch(sourcePath, (_eventType) => {
        this.#handleFsNotification(sourcePath);
      });

      if (typeof (watcher as any).unref === "function") {
        (watcher as any).unref();
      }

      watcher.on("error", (_err) => {
        // Tolerant to transient filesystem errors (e.g. atomic rename/replace)
        this.#handleFsNotification(sourcePath);
      });

      this.#watchers.set(sourcePath, watcher);
    } catch {
      // If file doesn't exist yet, watch might throw. Will retry on explicit check or create.
    }
  }

  #unwatchFile(sourcePath: string): void {
    const watcher = this.#watchers.get(sourcePath);
    if (watcher) {
      watcher.close();
      this.#watchers.delete(sourcePath);
    }
  }

  #handleFsNotification(sourcePath: string): void {
    const existingTimer = this.#debounceTimers.get(sourcePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.#debounceTimers.delete(sourcePath);
      await this.#checkSource(sourcePath);
    }, this.#debounceMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    this.#debounceTimers.set(sourcePath, timer);
  }

  async #checkSource(sourcePath: string): Promise<SourceChangeEvent | null> {
    const assetId = this.#pathToAssetId.get(sourcePath);
    if (!assetId) return null;

    let bytes: Uint8Array;
    try {
      bytes = await this.#readFileWithRetry(sourcePath);
    } catch {
      return null;
    }

    const newHash = hashBytes(bytes);
    const oldHash = this.#knownHashes.get(assetId);

    if (oldHash === newHash) {
      // Content has not semantically changed; suppress event
      return null;
    }

    this.#knownHashes.set(assetId, newHash);
    const event: SourceChangeEvent = {
      type: "asset.changeDetected",
      assetId,
      sourcePath,
      oldContentHash: oldHash,
      newContentHash: newHash,
    };

    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in SourceAssetWatcher event listener:", err);
      }
    }

    return event;
  }

  async triggerCheck(assetId?: string): Promise<SourceChangeEvent[]> {
    const results: SourceChangeEvent[] = [];
    if (assetId) {
      const path = this.#assets.get(assetId);
      if (path) {
        const ev = await this.#checkSource(path);
        if (ev) results.push(ev);
      }
    } else {
      for (const path of this.#assets.values()) {
        const ev = await this.#checkSource(path);
        if (ev) results.push(ev);
      }
    }
    return results;
  }

  async #readFileWithRetry(filePath: string): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        const buffer = await readFile(filePath);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } catch (err: any) {
        lastError = err;
        if (attempt < this.#maxRetries && (err?.code === "EBUSY" || err?.code === "ENOENT" || err?.code === "EPERM")) {
          await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs));
          continue;
        }
        break;
      }
    }
    throw lastError;
  }
}
