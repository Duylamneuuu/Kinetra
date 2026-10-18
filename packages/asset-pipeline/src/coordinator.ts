import { readFile } from "node:fs/promises";
import type { AssetDatabase } from "./database.js";
import type {
  AssetReimportService,
  FileSystemAdapter,
  ReimportEvent,
} from "./reimport.js";
import type { SourceAssetWatcher } from "./watcher.js";
import type { AssetDiagnostic } from "./types.js";

/**
 * What a runtime reports it could not carry over when it swapped a reloaded asset in. A reload can
 * succeed and still silently switch features off (the root bone is gone, an IK chain no longer
 * exists); these maps make that visible to the agent layer. Every field is absent when empty.
 */
export interface RuntimeReloadDegradation {
  /** Entity -> why root motion could not be re-enabled on the reloaded asset (e.g. root bone gone). */
  droppedRootMotion?: Record<string, string> | undefined;
  /** Entity -> IK chains with active targets the reloaded asset no longer supports. */
  droppedIkChains?: Record<string, string[]> | undefined;
  /** Entity -> morph overrides the reloaded asset no longer supports. */
  droppedMorphOverrides?: Record<string, string[]> | undefined;
}

export interface RuntimeReloadResult extends RuntimeReloadDegradation {
  success: boolean;
  affectedEntities: string[];
  error?: string | undefined;
}

export interface RuntimeReloadTarget {
  updateAsset(
    assetId: string,
    dataBase64: string,
    options?: { fingerprint?: string; sourceHash?: string },
  ): Promise<unknown>;
  reloadAsset(assetId: string): Promise<RuntimeReloadResult>;
  queryEntities?(): Promise<Array<{ entityId: string; model?: { assetId?: string | undefined } | undefined }>>;
  queryState?(): Promise<any>;
}

export interface AssetHotReloadTransaction extends RuntimeReloadDegradation {
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

/**
 * Own-property-safe merge of per-entity maps from a runtime (an entity id may be `__proto__`).
 * The runtime is a plugin boundary, so entries whose value `accept` rejects are skipped rather than
 * thrown on.
 */
function mergeEntityMaps<T>(
  into: Map<string, T>,
  from: unknown,
  accept: (value: unknown) => T | undefined,
): void {
  if (typeof from !== "object" || from === null || Array.isArray(from)) return;
  for (const key of Object.keys(from)) {
    const value = accept(Object.getOwnPropertyDescriptor(from, key)?.value);
    if (value !== undefined) into.set(key, value);
  }
}

function acceptReason(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function acceptNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((n): n is string => typeof n === "string");
  return names.length > 0 ? names : undefined;
}

function entityMapToRecord<T>(map: Map<string, T>): Record<string, T> | undefined {
  return map.size > 0 ? (Object.fromEntries(map) as Record<string, T>) : undefined;
}

/** Per-entity degradation reports collected while publishing one batch of assets to the runtime. */
interface ReloadDegradationAccumulator {
  droppedRootMotion: Map<string, string>;
  droppedIkChains: Map<string, string[]>;
  droppedMorphOverrides: Map<string, string[]>;
}

export interface AssetHotReloadCoordinatorOptions {
  database: AssetDatabase;
  reimportService: AssetReimportService;
  watcher: SourceAssetWatcher;
  runtimeTarget?: RuntimeReloadTarget;
  fileSystem?: FileSystemAdapter;
  onEvent?: (event: ReimportEvent) => void;
  onTransaction?: (tx: AssetHotReloadTransaction) => void;
  /**
   * How many finished transactions `getTransactionHistory()` keeps (the newest ones). A watch session
   * can run for days, so an unbounded list is a slow memory leak. Default {@link DEFAULT_MAX_TRANSACTION_HISTORY}.
   */
  maxTransactionHistory?: number;
}

/** Default size of the coordinator's transaction history. */
export const DEFAULT_MAX_TRANSACTION_HISTORY = 100;

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
  /** Bumped by stop(): changes queued before a stop must not run after it. */
  #epoch = 0;
  readonly #maxHistory: number;
  /**
   * Assets whose newest artifact never reached the runtime (`updateAsset` threw or the artifact could not be
   * read). The database and the watcher already hold the new hash, so no further file event would ever retry
   * them: they stay here until a publish succeeds ({@link retryRuntimePublish}, or the next change event).
   */
  readonly #runtimeStale = new Set<string>();

  constructor(options: AssetHotReloadCoordinatorOptions) {
    const maxHistory = options.maxTransactionHistory ?? DEFAULT_MAX_TRANSACTION_HISTORY;
    if (!Number.isInteger(maxHistory) || maxHistory < 1) {
      throw new RangeError(`maxTransactionHistory must be a positive integer, got ${String(maxHistory)}`);
    }
    this.#maxHistory = maxHistory;
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

  /** Asset ids whose latest rebuilt artifact the runtime has not received yet (publish failed), in insertion order. */
  getRuntimeStaleAssetIds(): readonly string[] {
    return [...this.#runtimeStale];
  }

  /**
   * Publish every runtime-stale asset again (see {@link getRuntimeStaleAssetIds}). Returns the resulting
   * transaction, or `null` when nothing was stale. Serialized with `processAssetChange`.
   */
  async retryRuntimePublish(): Promise<AssetHotReloadTransaction | null> {
    const epoch = this.#epoch;
    while (this.#inFlightPromise) {
      await this.#inFlightPromise.catch(() => {});
    }
    if (epoch !== this.#epoch) return null;
    const currentPromise = this.#republishStale();
    this.#inFlightPromise = currentPromise;
    try {
      return await currentPromise;
    } finally {
      if (this.#inFlightPromise === currentPromise) {
        this.#inFlightPromise = undefined;
      }
    }
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
    // Cancels every change still queued behind the in-flight transaction (see processAssetChange).
    this.#epoch++;
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
    const epoch = this.#epoch;
    while (this.#inFlightPromise) {
      await this.#inFlightPromise.catch(() => {});
    }
    // stop() was called while this change was queued behind another transaction: drop it instead of
    // reimporting and publishing to a runtime the caller already tore down.
    if (epoch !== this.#epoch) return null;

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
      // Source content hash unchanged / touch only -> no new rebuild. But when an earlier publish of this
      // asset failed, the runtime still holds the old bytes and this is the only chance to retry.
      if (this.#runtimeStale.has(assetId)) return this.#republishStale();
      return null;
    }

    const runtimeReloadedEntityIds: string[] = [];
    const runtimeUnchangedEntityIds: string[] = [];
    const droppedRootMotion = new Map<string, string>();
    const droppedIkChains = new Map<string, string[]>();
    const droppedMorphOverrides = new Map<string, string[]>();

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

    // 2. Publish and reload each successfully rebuilt asset to the runtime. Assets left stale by an earlier
    // failed publish ride along, so one successful transaction heals them.
    if (this.#runtimeTarget) {
      const publishIds = [...rebuildResult.rebuiltAssetIds];
      for (const staleId of this.#runtimeStale) {
        if (!publishIds.includes(staleId)) publishIds.push(staleId);
      }
      await this.#publishToRuntime(publishIds, runtimeReloadedEntityIds, { droppedRootMotion, droppedIkChains, droppedMorphOverrides });
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
      ...(entityMapToRecord(droppedRootMotion) ? { droppedRootMotion: entityMapToRecord(droppedRootMotion) } : {}),
      ...(entityMapToRecord(droppedIkChains) ? { droppedIkChains: entityMapToRecord(droppedIkChains) } : {}),
      ...(entityMapToRecord(droppedMorphOverrides)
        ? { droppedMorphOverrides: entityMapToRecord(droppedMorphOverrides) }
        : {}),
    };

    this.#recordTransaction(tx);

    return tx;
  }

  async #publishToRuntime(
    assetIds: readonly string[],
    runtimeReloadedEntityIds: string[],
    dropped: ReloadDegradationAccumulator,
  ): Promise<void> {
    if (!this.#runtimeTarget) return;
    for (const rebuiltId of assetIds) {
      const updatedRecord = this.#database.get(rebuiltId);
      if (!updatedRecord) {
        this.#runtimeStale.delete(rebuiltId);
        continue;
      }

      let artifactBytes: Uint8Array;
      try {
        artifactBytes = await this.#fs.readFile(updatedRecord.importedPath);
      } catch (err) {
        this.#runtimeStale.add(rebuiltId);
        this.#emit({
          type: "asset.runtimeReloadFailed",
          assetId: rebuiltId,
          error: `cannot read imported artifact "${updatedRecord.importedPath}": ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const base64 = Buffer.from(artifactBytes).toString("base64");

      // Publish to runtime resolver. A runtime that rejects the new bytes must not abort the whole
      // transaction (it would be lost from the history and waitForAssetReload would time out), and
      // reloading against stale bytes would be wrong, so report the failure, remember the asset as
      // runtime-stale (nothing else would retry it) and move on.
      try {
        await this.#runtimeTarget.updateAsset(rebuiltId, base64, {
          fingerprint: updatedRecord.fingerprint,
          sourceHash: updatedRecord.source.contentHash,
        });
      } catch (err) {
        this.#runtimeStale.add(rebuiltId);
        this.#emit({
          type: "asset.runtimeReloadFailed",
          assetId: rebuiltId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.#runtimeStale.delete(rebuiltId);

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
          // The reload worked but the runtime could not keep some features alive on the new
          // asset. Surface it as a warning event and on the transaction instead of staying silent.
          const degradedRoot = new Map<string, string>();
          const degradedIk = new Map<string, string[]>();
          const degradedMorph = new Map<string, string[]>();
          mergeEntityMaps(degradedRoot, reloadRes.droppedRootMotion, acceptReason);
          mergeEntityMaps(degradedIk, reloadRes.droppedIkChains, acceptNames);
          mergeEntityMaps(degradedMorph, reloadRes.droppedMorphOverrides, acceptNames);
          if (degradedRoot.size + degradedIk.size + degradedMorph.size > 0) {
            for (const [k, v] of degradedRoot) dropped.droppedRootMotion.set(k, v);
            for (const [k, v] of degradedIk) dropped.droppedIkChains.set(k, v);
            for (const [k, v] of degradedMorph) dropped.droppedMorphOverrides.set(k, v);
            const diagnostics: AssetDiagnostic[] = [];
            for (const [entityId, reason] of degradedRoot) {
              diagnostics.push({
                severity: "warning",
                code: "asset.reload.rootMotionDropped",
                message: `Root motion on entity "${entityId}" was switched off by the reload of "${rebuiltId}": ${reason}`,
                path: entityId,
              });
            }
            for (const [entityId, chains] of degradedIk) {
              diagnostics.push({
                severity: "warning",
                code: "asset.reload.ikChainsDropped",
                message: `IK chains [${chains.join(", ")}] on entity "${entityId}" were dropped by the reload of "${rebuiltId}"`,
                path: entityId,
              });
            }
            for (const [entityId, names] of degradedMorph) {
              diagnostics.push({
                severity: "warning",
                code: "asset.reload.morphOverridesDropped",
                message: `Morph overrides [${names.join(", ")}] on entity "${entityId}" were dropped by the reload of "${rebuiltId}"`,
                path: entityId,
              });
            }
            this.#emit({
              type: "asset.runtimeReloadDegraded",
              assetId: rebuiltId,
              fingerprint: updatedRecord.fingerprint,
              affectedAssetIds: reloadRes.affectedEntities,
              diagnostics,
              ...(degradedRoot.size > 0 ? { droppedRootMotion: Object.fromEntries(degradedRoot) } : {}),
              ...(degradedIk.size > 0 ? { droppedIkChains: Object.fromEntries(degradedIk) } : {}),
              ...(degradedMorph.size > 0 ? { droppedMorphOverrides: Object.fromEntries(degradedMorph) } : {}),
            });
          }
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

  async #republishStale(): Promise<AssetHotReloadTransaction | null> {
    if (!this.#runtimeTarget || this.#runtimeStale.size === 0) return null;
    const ids = [...this.#runtimeStale];
    const runtimeReloadedEntityIds: string[] = [];
    const droppedRootMotion = new Map<string, string>();
    const droppedIkChains = new Map<string, string[]>();
    const droppedMorphOverrides = new Map<string, string[]>();
    await this.#publishToRuntime(ids, runtimeReloadedEntityIds, { droppedRootMotion, droppedIkChains, droppedMorphOverrides });

    const rootId = ids[0] as string;
    const record = this.#database.get(rootId);
    const tx: AssetHotReloadTransaction = {
      rootAssetId: rootId,
      oldSourceHash: record?.source.contentHash,
      newSourceHash: record?.source.contentHash ?? "",
      importer: record?.recipe.importer ?? "",
      rebuildOrder: ids,
      rebuiltAssetIds: ids.filter((id) => !this.#runtimeStale.has(id)),
      blockedAssetIds: [],
      unaffectedAssetIds: [],
      oldFingerprint: record?.fingerprint,
      newFingerprint: record?.fingerprint ?? "",
      runtimeReloadedEntityIds,
      runtimeUnchangedEntityIds: [],
      error: this.#runtimeStale.size > 0 ? `runtime publish still failing for: ${[...this.#runtimeStale].join(", ")}` : undefined,
      ...(entityMapToRecord(droppedRootMotion) ? { droppedRootMotion: entityMapToRecord(droppedRootMotion) } : {}),
      ...(entityMapToRecord(droppedIkChains) ? { droppedIkChains: entityMapToRecord(droppedIkChains) } : {}),
      ...(entityMapToRecord(droppedMorphOverrides)
        ? { droppedMorphOverrides: entityMapToRecord(droppedMorphOverrides) }
        : {}),
    };
    this.#recordTransaction(tx);
    return tx;
  }

  #recordTransaction(tx: AssetHotReloadTransaction): void {
    this.#txHistory.push(tx);
    if (this.#txHistory.length > this.#maxHistory) {
      this.#txHistory.splice(0, this.#txHistory.length - this.#maxHistory);
    }
    for (const listener of this.#txListeners) {
      try {
        listener(tx);
      } catch (err) {
        console.error("Error in transaction listener:", err);
      }
    }
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
