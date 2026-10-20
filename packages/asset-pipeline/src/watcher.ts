import { hashBytes } from "./hash.js";

/** Handle returned by a {@link SourceWatchAdapter}. Node's `FSWatcher` satisfies this. */
export interface SourceFileWatch {
  close(): void;
  on(event: "error", listener: (error: unknown) => void): void;
  unref?(): void;
}

/**
 * How {@link SourceAssetWatcher} sees the disk. The Node package entry installs a `node:fs`
 * adapter. A browser bundle does not, and only needs one when a source is actually watched.
 */
export interface SourceWatchAdapter {
  watch(path: string, listener: (eventType: string) => void): SourceFileWatch;
  readFile(path: string): Promise<Uint8Array>;
}

let defaultWatchAdapter: SourceWatchAdapter | undefined;

export function setDefaultSourceWatchAdapter(adapter: SourceWatchAdapter): void {
  defaultWatchAdapter = adapter;
}

function resolveWatchAdapter(override: SourceWatchAdapter | undefined): SourceWatchAdapter {
  const adapter = override ?? defaultWatchAdapter;
  if (!adapter) {
    throw new Error(
      "[asset-pipeline.platform.missingWatchAdapter] Pass options.watchAdapter, or import @kinetra/asset-pipeline so the Node entry can watch files.",
    );
  }
  return adapter;
}

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
  /** How often to look for a watched source that is currently missing (default 200 ms). */
  rearmIntervalMs?: number;
  onEvent?: (event: SourceChangeEvent) => void;
  /** Disk watcher. Defaults to the adapter registered by the Node package entry. */
  watchAdapter?: SourceWatchAdapter;
}

export class SourceAssetWatcher {
  readonly #debounceMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #listeners = new Set<(event: SourceChangeEvent) => void>();

  #assets = new Map<string, string>(); // assetId -> sourcePath
  #pathToAssetId = new Map<string, string>(); // sourcePath -> assetId
  #knownHashes = new Map<string, string>(); // assetId -> contentHash
  #watchers = new Map<string, SourceFileWatch>(); // sourcePath -> watcher
  #debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** sourcePath -> pending retry of watching a file that did not exist. */
  #rearmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #rearmMs: number;
  readonly #watchAdapter: SourceWatchAdapter | undefined;
  #running = false;
  /** Bumped by every stop(); a start() that outlives its generation must not create watchers. */
  #generation = 0;

  constructor(options: SourceAssetWatcherOptions = {}) {
    this.#debounceMs = options.debounceMs ?? 60;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 20;
    this.#rearmMs = options.rearmIntervalMs ?? 200;
    this.#watchAdapter = options.watchAdapter;
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
    const previousPath = this.#assets.get(assetId);
    if (previousPath !== undefined && previousPath !== sourcePath) {
      // Re-pointing an asset: stop watching the abandoned path and forget the
      // hash of the old file, otherwise edits to the old file keep firing
      // change events for this asset and the old FSWatcher leaks.
      this.#detachPath(assetId, previousPath);
      this.#knownHashes.delete(assetId);
    }
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
    if (sourcePath) this.#detachPath(assetId, sourcePath);
    this.#assets.delete(assetId);
    this.#knownHashes.delete(assetId);
  }

  /** Release `sourcePath` if `assetId` still owns it (another asset may have claimed it). */
  #detachPath(assetId: string, sourcePath: string): void {
    if (this.#pathToAssetId.get(sourcePath) !== assetId) return;
    this.#unwatchFile(sourcePath);
    this.#cancelRearm(sourcePath);
    this.#pathToAssetId.delete(sourcePath);
    const timer = this.#debounceTimers.get(sourcePath);
    if (timer) {
      clearTimeout(timer);
      this.#debounceTimers.delete(sourcePath);
    }
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
    const generation = this.#generation;

    for (const [assetId, sourcePath] of [...this.#assets]) {
      if (!this.#knownHashes.has(assetId)) {
        try {
          const bytes = await this.#readFileWithRetry(sourcePath);
          // Do not clobber a hash recorded meanwhile (setKnownHash / an earlier check).
          if (!this.#knownHashes.has(assetId)) this.#knownHashes.set(assetId, hashBytes(bytes));
        } catch {
          // File may not exist yet; watcher will handle creation
        }
        // stop() (or stop() + start()) ran while the file was being read: this start is obsolete,
        // and carrying on would leave FSWatchers alive on a stopped watcher.
        if (!this.#running || generation !== this.#generation) return;
      }
      // The asset may have been removed or re-pointed while we awaited.
      if (this.#assets.get(assetId) !== sourcePath) continue;
      this.#watchFile(sourcePath);
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#generation++;
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();

    for (const timer of this.#debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.#debounceTimers.clear();
    for (const timer of this.#rearmTimers.values()) {
      clearTimeout(timer);
    }
    this.#rearmTimers.clear();
  }

  #watchFile(sourcePath: string): void {
    if (this.#watchers.has(sourcePath)) return;
    const adapter = resolveWatchAdapter(this.#watchAdapter);

    try {
      const watcher = adapter.watch(sourcePath, (eventType) => {
        if (eventType === "rename") {
          // On Linux (inotify), an atomic replace / rename detaches the watcher from the old inode.
          // Re-establish watcher on the destination path so subsequent modifications are caught.
          this.#unwatchFile(sourcePath);
          this.#watchFile(sourcePath);
        }
        this.#handleFsNotification(sourcePath);
      });

      if (typeof (watcher as any).unref === "function") {
        (watcher as any).unref();
      }

      watcher.on("error", (_err) => {
        // Tolerant to transient filesystem errors (e.g. atomic rename/replace)
        this.#unwatchFile(sourcePath);
        this.#watchFile(sourcePath);
        this.#handleFsNotification(sourcePath);
      });

      this.#watchers.set(sourcePath, watcher);
    } catch {
      // The file does not exist right now (deleted, or moved aside by an editor that keeps a
      // backup and writes a new file a moment later, as Blender does with "<name>.blend1").
      // Nothing would ever notify us again, so keep trying until the file is back.
      this.#scheduleRearm(sourcePath);
    }
  }

  /** Poll for a source that could not be watched; once it can be, check it for changes. */
  #scheduleRearm(sourcePath: string): void {
    if (!this.#running || this.#rearmTimers.has(sourcePath) || !this.#pathToAssetId.has(sourcePath)) return;
    const timer = setTimeout(() => {
      this.#rearmTimers.delete(sourcePath);
      if (!this.#running || !this.#pathToAssetId.has(sourcePath) || this.#watchers.has(sourcePath)) return;
      this.#watchFile(sourcePath); // reschedules itself while the file is still missing
      if (this.#watchers.has(sourcePath)) this.#handleFsNotification(sourcePath);
    }, this.#rearmMs);
    if (typeof timer.unref === "function") timer.unref();
    this.#rearmTimers.set(sourcePath, timer);
  }

  #cancelRearm(sourcePath: string): void {
    const timer = this.#rearmTimers.get(sourcePath);
    if (timer) {
      clearTimeout(timer);
      this.#rearmTimers.delete(sourcePath);
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
    if (this.#running && !this.#watchers.has(sourcePath)) {
      this.#watchFile(sourcePath);
    }

    const assetId = this.#pathToAssetId.get(sourcePath);
    if (!assetId) return null;

    const generation = this.#generation;
    let bytes: Uint8Array;
    try {
      bytes = await this.#readFileWithRetry(sourcePath);
    } catch {
      return null;
    }

    // The read is asynchronous: stop() may have run, or the asset may have been removed or
    // re-pointed (or the path handed to another asset). Reporting a change now would emit an event
    // for an asset that no longer owns this file and resurrect its forgotten hash. The hash is left
    // untouched so a later check still sees the change.
    if (generation !== this.#generation) return null;
    if (this.#pathToAssetId.get(sourcePath) !== assetId || this.#assets.get(assetId) !== sourcePath) {
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
        return await resolveWatchAdapter(this.#watchAdapter).readFile(filePath);
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
