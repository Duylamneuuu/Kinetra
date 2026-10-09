import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { AssetDatabase } from "./database.js";
import { inspectGlb } from "./glb.js";
import { hashBytes, importFingerprint } from "./hash.js";
import type {
  AssetDiagnostic,
  AssetMetadata,
  AssetRecord,
  ImportRecipe,
} from "./types.js";

export type ReimportStatus = "noop" | "reimported" | "failed";

export interface ReimportEvent {
  type:
    | "asset.changeDetected"
    | "asset.reimportStarted"
    | "asset.reimportNoop"
    | "asset.reimportSucceeded"
    | "asset.reimportFailed"
    | "asset.invalidated"
    | "asset.dependentReimportStarted"
    | "asset.dependentReimportSucceeded"
    | "asset.dependentReimportFailed"
    | "asset.runtimeReloadStarted"
    | "asset.runtimeReloadSucceeded"
    | "asset.runtimeReloadFailed";
  assetId: string;
  oldContentHash?: string | undefined;
  newContentHash?: string | undefined;
  oldFingerprint?: string | undefined;
  newFingerprint?: string | undefined;
  sourceHash?: string | undefined;
  fingerprint?: string | undefined;
  affectedAssetIds?: string[] | undefined;
  error?: string | undefined;
  diagnostics?: AssetDiagnostic[] | undefined;
}

export interface DependencyRebuildResult {
  rootAssetId: string;
  status: "reimported" | "noop" | "failed" | "partial_failure";
  oldSourceHash?: string | undefined;
  newSourceHash?: string | undefined;
  oldFingerprint?: string | undefined;
  newFingerprint?: string | undefined;
  rebuildOrder: string[];
  rebuiltAssetIds: string[];
  failedAssetId?: string | undefined;
  blockedAssetIds: string[];
  unaffectedAssetIds: string[];
  error?: string | undefined;
}

export interface ReimportResult {
  status: ReimportStatus;
  assetId: string;
  fingerprint?: string | undefined;
  oldFingerprint?: string | undefined;
  newFingerprint?: string | undefined;
  sourceHash?: string | undefined;
  affectedAssetIds: string[];
  error?: string | undefined;
  diagnostics?: AssetDiagnostic[] | undefined;
}

export interface AssetImporterContext {
  assetId: string;
  sourcePath: string;
  sourceBytes: Uint8Array;
  sourceHash: string;
  recipe: ImportRecipe;
  targetPath: string;
}

export interface AssetImporterResult {
  artifactBytes: Uint8Array;
  metadata?: Partial<AssetMetadata>;
  diagnostics?: AssetDiagnostic[];
}

export interface AssetImporter {
  import(context: AssetImporterContext): Promise<AssetImporterResult>;
}

export interface FileSystemAdapter {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
}

const nodeFileSystem: FileSystemAdapter = {
  async readFile(p: string) {
    const buf = await readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
  async writeFile(p: string, data: Uint8Array) {
    await writeFile(p, data);
  },
  async rename(oldPath: string, newPath: string) {
    // Windows rename resilience: if destination exists or is locked briefly, retry
    let retries = 3;
    while (retries > 0) {
      try {
        await rename(oldPath, newPath);
        return;
      } catch (err: any) {
        retries--;
        if (retries === 0 || (err?.code !== "EPERM" && err?.code !== "EBUSY")) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  },
  async unlink(p: string) {
    await unlink(p).catch(() => {});
  },
  async mkdir(p: string, options?: { recursive?: boolean }) {
    return await mkdir(p, options);
  },
};

export class GlbDirectImporter implements AssetImporter {
  async import(context: AssetImporterContext): Promise<AssetImporterResult> {
    // Validate GLB header
    inspectGlb(context.sourceBytes);
    return {
      artifactBytes: context.sourceBytes,
      metadata: {
        dimensions: [1, 1, 1],
      },
    };
  }
}

export interface AssetReimportServiceOptions {
  database: AssetDatabase;
  importers?: Map<string, AssetImporter>;
  onEvent?: (event: ReimportEvent) => void;
  fileSystem?: FileSystemAdapter;
}

export class AssetReimportService {
  readonly #database: AssetDatabase;
  readonly #importers = new Map<string, AssetImporter>();
  readonly #listeners = new Set<(event: ReimportEvent) => void>();
  readonly #fs: FileSystemAdapter;
  /** Tail of the reimport chain per asset: overlapping reimports of one asset run strictly in order. */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: AssetReimportServiceOptions) {
    this.#database = options.database;
    this.#fs = options.fileSystem ?? nodeFileSystem;

    // Register built-in default importers
    this.#importers.set("glb", new GlbDirectImporter());
    this.#importers.set("direct-glb", new GlbDirectImporter());
    this.#importers.set("passthrough", new GlbDirectImporter());

    if (options.importers) {
      for (const [k, v] of options.importers) {
        this.#importers.set(k, v);
      }
    }

    if (options.onEvent) {
      this.#listeners.add(options.onEvent);
    }
  }

  onEvent(listener: (event: ReimportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  registerImporter(name: string, importer: AssetImporter): void {
    this.#importers.set(name, importer);
  }

  getImporter(name: string): AssetImporter | undefined {
    return this.#importers.get(name);
  }

  getDatabase(): AssetDatabase {
    return this.#database;
  }

  /**
   * Reimport one asset. Calls for the same asset are serialized: each one re-reads the record and the
   * source only after the previous one finished, so a slow import of an older source can never overwrite
   * the artifact and fingerprint of a newer one. Different assets still reimport concurrently.
   */
  reimport(assetId: string): Promise<ReimportResult> {
    const previous = this.#queues.get(assetId) ?? Promise.resolve();
    const run = previous.then(() => this.#reimportNow(assetId));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(assetId, tail);
    void tail.then(() => {
      if (this.#queues.get(assetId) === tail) this.#queues.delete(assetId);
    });
    return run;
  }

  async #reimportNow(assetId: string): Promise<ReimportResult> {
    const record = this.#database.get(assetId);
    if (!record) {
      const error = `Asset "${assetId}" does not exist in AssetDatabase`;
      this.#emit({
        type: "asset.reimportFailed",
        assetId,
        error,
      });
      return {
        status: "failed",
        assetId,
        affectedAssetIds: [],
        error,
      };
    }

    // 1. Read source bytes and compute content hash
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await this.#fs.readFile(record.source.path);
    } catch (err) {
      const error = `Failed to read source file at "${record.source.path}": ${err instanceof Error ? err.message : String(err)}`;
      this.#emit({
        type: "asset.reimportFailed",
        assetId,
        error,
      });
      return {
        status: "failed",
        assetId,
        affectedAssetIds: [],
        error,
      };
    }

    const newSourceHash = hashBytes(sourceBytes);

    // 2. Collect dependency fingerprints
    const dependencyFingerprints: string[] = [];
    for (const depId of record.dependencies) {
      const depRecord = this.#database.get(depId);
      if (depRecord) {
        dependencyFingerprints.push(depRecord.fingerprint);
      }
    }

    // 3. Compute desired import fingerprint
    const desiredFingerprint = importFingerprint({
      sourceHash: newSourceHash,
      importer: record.recipe.importer,
      importerVersion: record.recipe.importerVersion,
      settings: record.recipe.settings,
      dependencyFingerprints,
    });

    // 4. Check if unchanged (NOOP)
    if (record.fingerprint === desiredFingerprint && record.source.contentHash === newSourceHash) {
      let artifactExists = false;
      try {
        await this.#fs.readFile(record.importedPath);
        artifactExists = true;
      } catch {
        artifactExists = false;
      }

      if (artifactExists) {
        this.#emit({
          type: "asset.reimportNoop",
          assetId,
          fingerprint: record.fingerprint,
          sourceHash: newSourceHash,
        });
        return {
          status: "noop",
          assetId,
          fingerprint: record.fingerprint,
          oldFingerprint: record.fingerprint,
          newFingerprint: record.fingerprint,
          sourceHash: newSourceHash,
          affectedAssetIds: [],
        };
      }
    }

    // 5. Notify reimport started
    this.#emit({
      type: "asset.reimportStarted",
      assetId,
      oldContentHash: record.source.contentHash,
      newContentHash: newSourceHash,
      oldFingerprint: record.fingerprint,
      newFingerprint: desiredFingerprint,
    });

    // 6. Find importer
    const importerName = record.recipe.importer;
    const importer = this.#importers.get(importerName);
    if (!importer) {
      const error = `No importer registered for recipe importer "${importerName}"`;
      this.#emit({
        type: "asset.reimportFailed",
        assetId,
        error,
      });
      return {
        status: "failed",
        assetId,
        affectedAssetIds: [],
        error,
      };
    }

    // 7. Execute importer to generate temp artifact
    const targetPath = record.importedPath;
    const ext = extname(targetPath);
    const baseWithoutExt = ext ? targetPath.slice(0, -ext.length) : targetPath;
    const tempPath = `${baseWithoutExt}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}${ext}`;
    let importResult: AssetImporterResult;

    try {
      importResult = await importer.import({
        assetId,
        sourcePath: record.source.path,
        sourceBytes,
        sourceHash: newSourceHash,
        recipe: record.recipe,
        targetPath: tempPath,
      });

      // 8. Validate output
      if (record.kind === "model") {
        inspectGlb(importResult.artifactBytes);
      }
    } catch (err) {
      // Clean up temp file if written
      await this.#fs.unlink(tempPath);
      const error = `Import or validation failed for asset "${assetId}": ${err instanceof Error ? err.message : String(err)}`;
      this.#emit({
        type: "asset.reimportFailed",
        assetId,
        error,
      });
      // Last known-good artifact remains intact!
      return {
        status: "failed",
        assetId,
        affectedAssetIds: [],
        error,
      };
    }

    // 9. Atomic replacement of final artifact
    try {
      await this.#fs.mkdir(dirname(targetPath), { recursive: true });
      await this.#fs.writeFile(tempPath, importResult.artifactBytes);
      await this.#fs.rename(tempPath, targetPath);
    } catch (err) {
      await this.#fs.unlink(tempPath);
      const error = `Failed to atomically write imported artifact to "${targetPath}": ${err instanceof Error ? err.message : String(err)}`;
      this.#emit({
        type: "asset.reimportFailed",
        assetId,
        error,
      });
      return {
        status: "failed",
        assetId,
        affectedAssetIds: [],
        error,
      };
    }

    // 10. Update AssetRecord in database
    const oldFingerprint = record.fingerprint;
    const updatedRecord: AssetRecord = {
      ...record,
      source: {
        ...record.source,
        contentHash: newSourceHash,
      },
      fingerprint: desiredFingerprint,
      metadata: {
        ...record.metadata,
        ...(importResult.metadata ?? {}),
      },
      diagnostics: importResult.diagnostics ?? [],
    };

    this.#database.upsert(updatedRecord);

    // 11. Determine invalidation set
    const affectedAssetIds = this.#database.invalidationSet(assetId);
    const dependents = this.#database.dependentsOf(assetId);
    for (const depId of dependents) {
      this.#emit({
        type: "asset.invalidated",
        assetId: depId,
        affectedAssetIds: [depId],
      });
    }

    // 12. Emit success
    this.#emit({
      type: "asset.reimportSucceeded",
      assetId,
      oldFingerprint,
      newFingerprint: desiredFingerprint,
      affectedAssetIds,
    });

    return {
      status: "reimported",
      assetId,
      fingerprint: desiredFingerprint,
      oldFingerprint,
      newFingerprint: desiredFingerprint,
      sourceHash: newSourceHash,
      affectedAssetIds,
      diagnostics: importResult.diagnostics,
    };
  }

  async reimportWithDependents(rootAssetId: string): Promise<DependencyRebuildResult> {
    const rootRecordBefore = this.#database.get(rootAssetId);
    const dependents = this.#database.dependentsInRebuildOrder(rootAssetId);
    const fullRebuildOrder = [rootAssetId, ...dependents];
    const allAssets = this.#database.list().map((a) => a.id);
    const unaffected = allAssets.filter((id) => !fullRebuildOrder.includes(id));

    // 1. Reimport root asset
    const rootResult = await this.reimport(rootAssetId);

    if (rootResult.status === "failed") {
      return {
        rootAssetId,
        status: "failed",
        oldSourceHash: rootRecordBefore?.source.contentHash,
        rebuildOrder: fullRebuildOrder,
        rebuiltAssetIds: [],
        failedAssetId: rootAssetId,
        blockedAssetIds: dependents,
        unaffectedAssetIds: unaffected,
        error: rootResult.error,
      };
    }

    if (rootResult.status === "noop") {
      return {
        rootAssetId,
        status: "noop",
        oldSourceHash: rootRecordBefore?.source.contentHash,
        newSourceHash: rootRecordBefore?.source.contentHash,
        oldFingerprint: rootRecordBefore?.fingerprint,
        newFingerprint: rootRecordBefore?.fingerprint,
        rebuildOrder: [rootAssetId],
        rebuiltAssetIds: [],
        blockedAssetIds: [],
        unaffectedAssetIds: unaffected,
      };
    }

    // 2. Root succeeded - process dependents in topological order
    const rebuiltAssetIds: string[] = [rootAssetId];
    const failedAssetIds: string[] = [];
    const blockedAssetIds: string[] = [];

    for (const depId of dependents) {
      const depRecord = this.#database.get(depId);
      if (!depRecord) continue;

      // Check if depId depends on any failed or blocked asset
      const isBlocked = depRecord.dependencies.some(
        (d) => failedAssetIds.includes(d) || blockedAssetIds.includes(d),
      );
      if (isBlocked) {
        blockedAssetIds.push(depId);
        continue;
      }

      // Collect dependency fingerprints from current database state
      const depFingerprints = depRecord.dependencies.map(
        (d) => this.#database.get(d)?.fingerprint ?? "",
      );

      const desiredFingerprint = importFingerprint({
        sourceHash: depRecord.source.contentHash,
        importer: depRecord.recipe.importer,
        importerVersion: depRecord.recipe.importerVersion,
        settings: depRecord.recipe.settings,
        dependencyFingerprints: depFingerprints,
      });

      if (depRecord.fingerprint === desiredFingerprint) {
        // Unchanged
        continue;
      }

      // Stale - trigger rebuild
      this.#emit({
        type: "asset.dependentReimportStarted",
        assetId: depId,
        oldFingerprint: depRecord.fingerprint,
        newFingerprint: desiredFingerprint,
      });

      const depResult = await this.reimport(depId);
      if (depResult.status === "reimported") {
        rebuiltAssetIds.push(depId);
        this.#emit({
          type: "asset.dependentReimportSucceeded",
          assetId: depId,
          oldFingerprint: depRecord.fingerprint,
          newFingerprint: desiredFingerprint,
        });
      } else if (depResult.status === "failed") {
        failedAssetIds.push(depId);
        this.#emit({
          type: "asset.dependentReimportFailed",
          assetId: depId,
          error: depResult.error,
        });
      }
    }

    const hasFailed = failedAssetIds.length > 0;
    return {
      rootAssetId,
      status: hasFailed ? "partial_failure" : "reimported",
      oldSourceHash: rootRecordBefore?.source.contentHash,
      newSourceHash: rootResult.sourceHash,
      oldFingerprint: rootRecordBefore?.fingerprint,
      newFingerprint: rootResult.newFingerprint,
      rebuildOrder: fullRebuildOrder,
      rebuiltAssetIds,
      failedAssetId: failedAssetIds[0],
      blockedAssetIds,
      unaffectedAssetIds: unaffected,
      error: hasFailed ? `Dependent "${failedAssetIds[0]}" failed to reimport` : undefined,
    };
  }

  #emit(event: ReimportEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in AssetReimportService event listener:", err);
      }
    }
  }
}
