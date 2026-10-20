import {
  AssetHotReloadCoordinator,
  SourceAssetWatcher,
  inspectGlb,
  hashBytes,
  type AssetHotReloadTransaction,
  type ReimportEvent,
  type RuntimeReloadTarget,
} from "@kinetra/asset-pipeline/pure";

import {
  ORB_RUN_MODEL_ASSET,
  ORB_RUN_MODEL_ASSET_IDS,
  createOrbRunAssetPipeline,
  importOrbRunAssets,
  type OrbRunAssetPipeline,
} from "./assets.js";
import { decodeBase64, encodeBase64 } from "./base64.js";
import { ORB_RUN_ENTITY } from "./ids.js";

/**
 * Hot reload of Orb Run content through the engine's own `AssetHotReloadCoordinator`.
 *
 * The coordinator needs a `RuntimeReloadTarget` (the thing that holds the loaded assets and swaps
 * them on a live game). The engine only ships the Electron player's, which needs WebGL, so
 * `OrbRunReloadTarget` is a headless stand-in: it keeps the *authoritative* record of which bytes
 * each model entity currently shows (`appliedTo`), validates what it is given like a real loader
 * would, and can be told to refuse. It never touches gameplay: reloading art must not move a single
 * script state or transform, which the tests pin with the replay digest.
 */

/** Which model asset each entity of the authored scene shows (the scene itself still uses primitives). */
export const ORB_RUN_MODEL_BINDINGS: Readonly<Record<string, string>> = {
  [ORB_RUN_ENTITY.orbA]: ORB_RUN_MODEL_ASSET.orb,
  [ORB_RUN_ENTITY.orbB]: ORB_RUN_MODEL_ASSET.orb,
  [ORB_RUN_ENTITY.orbC]: ORB_RUN_MODEL_ASSET.orb,
  [ORB_RUN_ENTITY.exit]: ORB_RUN_MODEL_ASSET.exitPad,
  [ORB_RUN_ENTITY.player]: ORB_RUN_MODEL_ASSET.player,
};

/** What an entity currently displays. */
export interface OrbRunAppliedModel {
  assetId: string;
  fingerprint: string;
  /** SHA-256 of the artifact bytes that were applied. */
  bytesHash: string;
}

/** Faults a test can inject, to prove the coordinator survives a runtime that says no. */
export interface OrbRunReloadFaults {
  /** `updateAsset` throws for these asset ids (the new bytes are refused). */
  refuseUpdate: Set<string>;
  /** `reloadAsset` reports `success:false` for these asset ids. */
  failReload: Set<string>;
  /** `reloadAsset` throws for these asset ids. */
  throwOnReload: Set<string>;
}

interface StagedAsset {
  fingerprint: string;
  sourceHash: string;
  bytesHash: string;
}

export class OrbRunReloadTarget implements RuntimeReloadTarget {
  readonly faults: OrbRunReloadFaults = {
    refuseUpdate: new Set(),
    failReload: new Set(),
    throwOnReload: new Set(),
  };
  /** Newest bytes published per asset (what `reloadAsset` will apply). */
  readonly #staged = new Map<string, StagedAsset>();
  readonly #applied = new Map<string, OrbRunAppliedModel>();
  readonly #updateCount = new Map<string, number>();
  readonly #reloadCount = new Map<string, number>();

  async updateAsset(
    assetId: string,
    dataBase64: string,
    options: { fingerprint?: string; sourceHash?: string } = {},
  ): Promise<void> {
    if (this.faults.refuseUpdate.has(assetId)) throw new Error(`runtime refused new bytes for "${assetId}"`);
    const bytes = decodeBase64(dataBase64);
    if (bytes.byteLength === 0) throw new Error(`"${assetId}" arrived empty`);
    // A loader would reject a model that is not a GLB; audio is decoded when played.
    if (ORB_RUN_MODEL_ASSET_IDS.includes(assetId)) inspectGlb(bytes);
    this.#staged.set(assetId, {
      fingerprint: options.fingerprint ?? "",
      sourceHash: options.sourceHash ?? "",
      bytesHash: hashBytes(bytes),
    });
    this.#updateCount.set(assetId, (this.#updateCount.get(assetId) ?? 0) + 1);
  }

  async reloadAsset(assetId: string): Promise<{ success: boolean; affectedEntities: string[]; error?: string }> {
    if (this.faults.throwOnReload.has(assetId)) throw new Error(`runtime crashed reloading "${assetId}"`);
    if (this.faults.failReload.has(assetId)) {
      return { success: false, affectedEntities: [], error: `runtime could not reload "${assetId}"` };
    }
    const staged = this.#staged.get(assetId);
    if (!staged) return { success: false, affectedEntities: [], error: `"${assetId}" was never published` };
    const affectedEntities = Object.entries(ORB_RUN_MODEL_BINDINGS)
      .filter(([, boundAsset]) => boundAsset === assetId)
      .map(([entityId]) => entityId)
      .sort();
    for (const entityId of affectedEntities) {
      this.#applied.set(entityId, { assetId, fingerprint: staged.fingerprint, bytesHash: staged.bytesHash });
    }
    this.#reloadCount.set(assetId, (this.#reloadCount.get(assetId) ?? 0) + 1);
    return { success: true, affectedEntities };
  }

  /** Every entity of the scene, with the model it shows (when it has one), for the coordinator's unchanged-entity report. */
  async queryEntities(): Promise<Array<{ entityId: string; model?: { assetId?: string | undefined } | undefined }>> {
    return Object.values(ORB_RUN_ENTITY)
      .slice()
      .sort()
      .map((entityId) => {
        const assetId = ORB_RUN_MODEL_BINDINGS[entityId];
        return assetId ? { entityId, model: { assetId } } : { entityId };
      });
  }

  /** What `entityId` currently displays; undefined before its first successful reload. */
  appliedTo(entityId: string): OrbRunAppliedModel | undefined {
    const applied = this.#applied.get(entityId);
    return applied ? { ...applied } : undefined;
  }

  /** The fingerprint last published for `assetId` (audio included). */
  stagedFingerprint(assetId: string): string | undefined {
    return this.#staged.get(assetId)?.fingerprint;
  }

  updateCount(assetId: string): number {
    return this.#updateCount.get(assetId) ?? 0;
  }

  reloadCount(assetId: string): number {
    return this.#reloadCount.get(assetId) ?? 0;
  }
}

export interface OrbRunHotReload {
  pipeline: OrbRunAssetPipeline;
  target: OrbRunReloadTarget;
  coordinator: AssetHotReloadCoordinator;
  /** Every coordinator event (reimport + runtime reload), in order. */
  events: ReimportEvent[];
  /** Every finished transaction, in order. */
  transactions: AssetHotReloadTransaction[];
  /**
   * An artist saves new source bytes for `assetId`: write them to the (in-memory) source file and let the
   * coordinator process the change, as the file watcher would. `null` when the bytes did not change anything.
   */
  editSource(assetId: string, bytes: Uint8Array): Promise<AssetHotReloadTransaction | null>;
  stop(): Promise<void>;
}

/**
 * The whole loop in plain Node: Orb Run content imported once and loaded into a headless runtime
 * (as the scene start of a real player would), then a started `AssetHotReloadCoordinator` ready for edits.
 * No disk, no WebGL, no timers.
 */
export async function createOrbRunHotReload(): Promise<OrbRunHotReload> {
  const pipeline = await createOrbRunAssetPipeline();
  for (const result of await importOrbRunAssets(pipeline)) {
    if (result.status === "failed") {
      throw new Error(`Orb Run asset "${result.assetId}" failed its first import: ${result.error ?? "unknown error"}`);
    }
  }
  const target = new OrbRunReloadTarget();
  // Scene start: publish and apply every imported artifact once.
  for (const record of pipeline.database.list()) {
    const bytes = await pipeline.fileSystem.readFile(record.importedPath);
    await target.updateAsset(record.id, encodeBase64(bytes), {
      fingerprint: record.fingerprint,
      sourceHash: record.source.contentHash,
    });
    const loaded = await target.reloadAsset(record.id);
    if (!loaded.success) throw new Error(`Orb Run asset "${record.id}" failed its first load: ${loaded.error ?? "unknown error"}`);
  }

  const events: ReimportEvent[] = [];
  const transactions: AssetHotReloadTransaction[] = [];
  // The watcher is never pointed at a path (the sources live in memory); `processAssetChange` is the
  // entry the watcher would call.
  const coordinator = new AssetHotReloadCoordinator({
    database: pipeline.database,
    reimportService: pipeline.service,
    watcher: new SourceAssetWatcher(),
    runtimeTarget: target,
    fileSystem: pipeline.fileSystem,
    onEvent: (event) => events.push(event),
    onTransaction: (tx) => transactions.push(tx),
  });
  await coordinator.start();

  return {
    pipeline,
    target,
    coordinator,
    events,
    transactions,
    async editSource(assetId, bytes) {
      const record = pipeline.database.get(assetId);
      if (!record) throw new RangeError(`Unknown Orb Run asset "${assetId}"`);
      await pipeline.fileSystem.writeFile(record.source.path, bytes);
      return coordinator.processAssetChange(assetId);
    },
    stop: () => coordinator.stop(),
  };
}
