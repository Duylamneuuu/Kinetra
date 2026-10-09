import { readFile } from "node:fs/promises";
import type { AssetDatabase } from "./database.js";
import type {
  AssetReimportService,
  FileSystemAdapter,
  ReimportEvent,
} from "./reimport.js";
import type { SourceAssetWatcher } from "./watcher.js";

export interface RuntimeReloadTarget {
  updateAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<unknown>;
  reloadAsset(
    assetId: string,
  ): Promise<{ success: boolean; affectedEntities: string[]; error?: string }>;
  queryEntities?(): Promise<Array<{ entityId: string; model?: { assetId?: string | undefined } | undefined }>>;
  queryState?(): Promise<any>;
}

export interface AssetHotReloadTransaction {
  rootAssetId: string;
  oldSourceHash?: string | undefined;
  newSourceHash: string;

  importer: string;
  blenderExitCode?: number | undefined;

  rebuildOrder: string[];
  rebuiltAssetIds: string[];
  failedAssetId?: string | undefined;
  blockedAssetIds: string[];
  unaffectedAssetIds: string[];

  oldFingerprint?: string | undefined;
  newFingerprint: string;

  runtimeReloadedEntityIds: string[];
  runtimeUnchangedEntityIds: string[];
  error?: string | undefined;
}

export interface AssetHotReloadCoordinatorOptions {
  database: AssetDatabase;
  reimportService: AssetReimportService;
  watcher: SourceAssetWatcher;
  runtimeTarget?: RuntimeReloadTarget;
  fileSystem?: FileSystemAdapter;
  onEvent?: (event: ReimportEvent) => void;
  onTransaction?: (tx: AssetHotReloadTransaction) => void;
}

const defaultNodeFs: FileSystemAdapter = {
  async readFile(p: string) {
    const buf = await readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
  async writeFile() {},
  async rename() {},
  async unlink() {},
  async mkdir() {
    return undefined;
  },
};

export class AssetHotReloadCoordinator {
  readonly #database: AssetDatabase;
  readonly #reimportService: AssetReimportService;
  readonly #watcher: SourceAssetWatcher;
  readonly #runtimeTarget?: RuntimeReloadTarget | undefined;
  readonly #fs: FileSystemAdapter;
  readonly #listeners = new Set<(event: ReimportEvent) => void>();
  readonly #txListeners = new Set<(tx: AssetHotReloadTransaction) => void>();
  readonly #txHistory: AssetHotReloadTransaction[] = [];
  #watcherUnsubscribe?: (() => void) | undefined;
  #serviceUnsubscribe?: (() => void) | undefined;
  #inFlightPromise?: Promise<AssetHotReloadTransaction | null> | undefined;
  #started = false;

  constructor(options: AssetHotReloadCoordinatorOptions) {
    this.#database = options.database;
    this.#reimportService = options.reimportService;
    this.#watcher = options.watcher;
    this.#runtimeTarget = options.runtimeTarget;
    this.#fs = options.fileSystem ?? defaultNodeFs;

    if (options.onEvent) {
      this.#listeners.add(options.onEvent);
    }
    if (options.onTransaction) {
      this.#txListeners.add(options.onTransaction);
    }
  }

  isStarted(): boolean {
    return this.#started;
  }

  getTransactionHistory(): readonly AssetHotReloadTransaction[] {
    return this.#txHistory;
  }

  onEvent(listener: (event: ReimportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onTransaction(listener: (tx: AssetHotReloadTransaction) => void): () => void {
    this.#txListeners.add(listener);
    return () => {
      this.#txListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    this.#watcherUnsubscribe = this.#watcher.onEvent((event) => {
      this.#emit(event);
      this.processAssetChange(event.assetId).catch((err) => {
        console.error(`AssetHotReloadCoordinator error on ${event.assetId}:`, err);
      });
    });

    this.#serviceUnsubscribe = this.#reimportService.onEvent((event) => {
      this.#emit(event);
    });

    try {
      await this.#watcher.start();
    } catch (err) {
      // A failed start must not leave the coordinator "started" with live subscriptions:
      // start() would then return early forever and every watcher event would be processed
      // by a coordinator that is not running.
      this.#watcherUnsubscribe?.();
      this.#serviceUnsubscribe?.();
      this.#watcherUnsubscribe = undefined;
      this.#serviceUnsubscribe = undefined;
      this.#started = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#watcherUnsubscribe) {
      this.#watcherUnsubscribe();
      this.#watcherUnsubscribe = undefined;
    }
    if (this.#serviceUnsubscribe) {
      this.#serviceUnsubscribe();
      this.#serviceUnsubscribe = undefined;
    }
    await this.#watcher.stop();
    if (this.#inFlightPromise) {
      await this.#inFlightPromise.catch(() => {});
    }
  }

  async processAssetChange(assetId: string): Promise<AssetHotReloadTransaction | null> {
    while (this.#inFlightPromise) {
      await this.#inFlightPromise.catch(() => {});
    }

    const currentPromise = this.#executeTransaction(assetId);
    this.#inFlightPromise = currentPromise;
    try {
      return await currentPromise;
    } finally {
      if (this.#inFlightPromise === currentPromise) {
        this.#inFlightPromise = undefined;
      }
    }
  }

  async #executeTransaction(assetId: string): Promise<AssetHotReloadTransaction | null> {
    const record = this.#database.get(assetId);
    if (!record) return null;

    // 1. Reimport root asset with all topological dependents
    const rebuildResult = await this.#reimportService.reimportWithDependents(assetId);

    if (rebuildResult.status === "noop") {
      // Source content hash unchanged / touch only -> no runtime reload transaction
      return null;
    }

    const runtimeReloadedEntityIds: string[] = [];
    const runtimeUnchangedEntityIds: string[] = [];

    // Query entities before reload to know unaffected / unchanged entities if supported
    let allEntityIds: string[] = [];
    const targetAny = this.#runtimeTarget as any;
    if (typeof targetAny?.queryEntities === "function") {
      try {
        const entities = await targetAny.queryEntities();
        allEntityIds = entities.map((e: any) => e.entityId);
      } catch {}
    } else if (typeof targetAny?.queryState === "function") {
      try {
        const state = await targetAny.queryState();
        if (state?.entities) {
          allEntityIds = state.entities.map((e: any) => e.entityId);
        }
      } catch {}
    } else if (typeof targetAny?.snapshot === "function") {
      try {
        const snap = await targetAny.snapshot();
        const entities = snap?.state?.entities ?? snap?.entities;
        if (Array.isArray(entities)) {
          allEntityIds = entities.map((e: any) => e.entityId);
        }
      } catch {}
    } else if (typeof targetAny?.host?.query === "function") {
      try {
        const res = await targetAny.host.query();
        if (Array.isArray(res?.entities)) {
          allEntityIds = res.entities.map((e: any) => e.entityId);
        }
      } catch {}
    }

    // 2. Publish and reload each successfully rebuilt asset to the runtime
    if (this.#runtimeTarget) {
      for (const rebuiltId of rebuildResult.rebuiltAssetIds) {
        const updatedRecord = this.#database.get(rebuiltId);
        if (!updatedRecord) continue;

        let artifactBytes: Uint8Array;
        try {
          artifactBytes = await this.#fs.readFile(updatedRecord.importedPath);
        } catch {
          continue;
        }

        const base64 = Buffer.from(artifactBytes).toString("base64");

        // Publish to runtime resolver. A runtime that rejects the new bytes must not abort the whole
        // transaction (it would be lost from the history and waitForAssetReload would time out), and
        // reloading against stale bytes would be wrong, so report the failure and move on.
        try {
          await this.#runtimeTarget.updateAsset(rebuiltId, base64, {
            fingerprint: updatedRecord.fingerprint,
            sourceHash: updatedRecord.source.contentHash,
          });
        } catch (err) {
          this.#emit({
            type: "asset.runtimeReloadFailed",
            assetId: rebuiltId,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        // Trigger live reload
        this.#emit({
          type: "asset.runtimeReloadStarted",
          assetId: rebuiltId,
          fingerprint: updatedRecord.fingerprint,
        });

        try {
          const reloadRes = await this.#runtimeTarget.reloadAsset(rebuiltId);
          if (reloadRes.success) {
            runtimeReloadedEntityIds.push(...reloadRes.affectedEntities);
            this.#emit({
              type: "asset.runtimeReloadSucceeded",
              assetId: rebuiltId,
              fingerprint: updatedRecord.fingerprint,
              affectedAssetIds: reloadRes.affectedEntities,
            });
          } else {
            this.#emit({
              type: "asset.runtimeReloadFailed",
              assetId: rebuiltId,
              error: reloadRes.error,
            });
          }
        } catch (err) {
          this.#emit({
            type: "asset.runtimeReloadFailed",
            assetId: rebuiltId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Determine unchanged entities
    for (const entId of allEntityIds) {
      if (!runtimeReloadedEntityIds.includes(entId)) {
        runtimeUnchangedEntityIds.push(entId);
      }
    }

    const tx: AssetHotReloadTransaction = {
      rootAssetId: assetId,
      oldSourceHash: rebuildResult.oldSourceHash,
      newSourceHash: rebuildResult.newSourceHash ?? "",
      importer: record.recipe.importer,
      rebuildOrder: rebuildResult.rebuildOrder,
      rebuiltAssetIds: rebuildResult.rebuiltAssetIds,
      failedAssetId: rebuildResult.failedAssetId,
      blockedAssetIds: rebuildResult.blockedAssetIds,
      unaffectedAssetIds: rebuildResult.unaffectedAssetIds,
      oldFingerprint: rebuildResult.oldFingerprint,
      newFingerprint: rebuildResult.newFingerprint ?? record.fingerprint,
      runtimeReloadedEntityIds,
      runtimeUnchangedEntityIds,
      error: rebuildResult.error,
    };

    this.#txHistory.push(tx);
    for (const listener of this.#txListeners) {
      try {
        listener(tx);
      } catch (err) {
        console.error("Error in transaction listener:", err);
      }
    }

    return tx;
  }

  waitForAssetReload(assetId: string, timeoutMs = 10_000): Promise<AssetHotReloadTransaction> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(
            `Timeout waiting for asset reload transaction on "${assetId}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const unsubscribe = this.onTransaction((tx) => {
        if (tx.rootAssetId === assetId || tx.rebuiltAssetIds.includes(assetId)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(tx);
        }
      });
    });
  }

  #emit(event: ReimportEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in coordinator event listener:", err);
      }
    }
  }
}
