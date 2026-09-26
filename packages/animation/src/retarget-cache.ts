import { existsSync, mkdirSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as THREE from "three";
import {
  type BakeRetargetOptions,
  type BakeRetargetResult,
  type RetargetDiagnostic,
  bakeRetargetedClip,
  computeRetargetCacheKey,
} from "./retarget.js";
import { skeletonSignature } from "./skeleton.js";

export const RETARGET_CACHE_SCHEMA_VERSION = 1;

/**
 * Engine-owned serialized representation for a baked animation clip.
 * Wrapping THREE.AnimationClip.toJSON() with deterministic metadata.
 */
export interface RetargetCacheRecord {
  schemaVersion: number;
  cacheKey: string;
  sourceAssetHash: string;
  sourceClipId: string;
  sourceSkeletonSignature: string;
  targetSkeletonSignature: string;
  retargetVersion: number;
  clip: ReturnType<typeof THREE.AnimationClip.prototype.toJSON>;
}

export interface RetargetCacheLookupResult {
  hit: boolean;
  record?: RetargetCacheRecord | undefined;
  clip?: THREE.AnimationClip | undefined;
  reason?: string | undefined;
}

export interface RetargetCacheStorage {
  get(key: string): Promise<string | null>;
  set(key: string, data: string): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  resolveIdentity(key: string): string;
}

/**
 * In-memory retarget cache storage for testing and ephemeral execution.
 */
export class MemoryRetargetCacheStorage implements RetargetCacheStorage {
  readonly #records = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.#records.get(key) ?? null;
  }

  async set(key: string, data: string): Promise<void> {
    this.#records.set(key, data);
  }

  async has(key: string): Promise<boolean> {
    return this.#records.has(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.#records.delete(key);
  }

  resolveIdentity(key: string): string {
    return `retarget/${key}.json`;
  }
}

export interface FileRetargetCacheStorageOptions {
  cacheDir: string;
}

/**
 * File-backed retarget cache storage.
 * Provides atomic writes, Windows retry semantics, and path traversal protection.
 */
export class FileRetargetCacheStorage implements RetargetCacheStorage {
  readonly #cacheDir: string;

  constructor(options: FileRetargetCacheStorageOptions) {
    this.#cacheDir = resolve(options.cacheDir);
    if (!existsSync(this.#cacheDir)) {
      mkdirSync(this.#cacheDir, { recursive: true });
    }
  }

  #resolvePath(key: string): string {
    if (!/^[a-zA-Z0-9_\-.]+$/.test(key)) {
      throw new Error(`Invalid retarget cache key format: "${key}"`);
    }
    const resolved = resolve(this.#cacheDir, `${key}.json`);
    const rel = resolved.slice(this.#cacheDir.length);
    if (resolved !== join(this.#cacheDir, `${key}.json`) || !rel.endsWith(`${key}.json`)) {
      throw new Error(`Potential path traversal detected for cache key: "${key}"`);
    }
    return resolved;
  }

  async get(key: string): Promise<string | null> {
    const filePath = this.#resolvePath(key);
    try {
      return await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async set(key: string, data: string): Promise<void> {
    const filePath = this.#resolvePath(key);
    const targetDir = dirname(filePath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const tempPath = join(targetDir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const fileHandle = await open(tempPath, "w");
    try {
      await fileHandle.writeFile(data, "utf-8");
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    // Atomic rename with Windows retry
    let renameAttempts = 0;
    const maxAttempts = 5;
    while (true) {
      try {
        await rename(tempPath, filePath);
        break;
      } catch (err: unknown) {
        renameAttempts++;
        if (renameAttempts >= maxAttempts) {
          try {
            await unlink(tempPath);
          } catch {
            // ignore cleanup failure
          }
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * renameAttempts));
      }
    }
  }

  async has(key: string): Promise<boolean> {
    const filePath = this.#resolvePath(key);
    return existsSync(filePath);
  }

  async delete(key: string): Promise<boolean> {
    const filePath = this.#resolvePath(key);
    try {
      await unlink(filePath);
      return true;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  resolveIdentity(key: string): string {
    return `retarget/${key}.json`;
  }
}

export interface RetargetBakeCacheOptions {
  storage?: RetargetCacheStorage | undefined;
  cacheDir?: string | undefined;
}

export interface RetargetBakeCacheResult {
  success: boolean;
  cacheHit: boolean;
  cacheKey: string;
  cacheIdentity: string;
  cachePath?: string | undefined;
  bakedClipName?: string | undefined;
  trackCount: number;
  duration: number;
  clip?: THREE.AnimationClip | undefined;
  record?: RetargetCacheRecord | undefined;
  regenerationReason?: string | undefined;
  diagnostics: RetargetDiagnostic[];
  error?: string | undefined;
}

export interface GetOrBakeOptions extends BakeRetargetOptions {
  bakeFn?: (options: BakeRetargetOptions) => BakeRetargetResult;
}

/**
 * RetargetBakeCache coordinates retarget key derivation, cache lookup,
 * baking fallback, persistence, and safe recovery from corruption or stale schemas.
 */
export class RetargetBakeCache {
  readonly storage: RetargetCacheStorage;

  constructor(options?: RetargetBakeCacheOptions) {
    if (options?.storage) {
      this.storage = options.storage;
    } else if (options?.cacheDir) {
      this.storage = new FileRetargetCacheStorage({ cacheDir: options.cacheDir });
    } else {
      this.storage = new MemoryRetargetCacheStorage();
    }
  }

  /**
   * Retrieves and validates a cached baked animation clip by cache key.
   * If corrupt or incompatible, safely indicates miss with a specific reason.
   */
  async get(cacheKey: string): Promise<RetargetCacheLookupResult> {
    let raw: string | null = null;
    try {
      raw = await this.storage.get(cacheKey);
    } catch {
      return { hit: false, reason: "storage_read_error" };
    }

    if (raw === null) {
      return { hit: false, reason: "miss" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { hit: false, reason: "corrupt_json" };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { hit: false, reason: "invalid_record_structure" };
    }

    const candidate = parsed as Partial<RetargetCacheRecord>;

    if (typeof candidate.schemaVersion !== "number" || candidate.schemaVersion !== RETARGET_CACHE_SCHEMA_VERSION) {
      return { hit: false, reason: "incompatible_schema_version" };
    }

    if (candidate.cacheKey !== cacheKey) {
      return { hit: false, reason: "cache_key_mismatch" };
    }

    if (!candidate.clip || typeof candidate.clip !== "object") {
      return { hit: false, reason: "invalid_record_structure" };
    }

    let clip: THREE.AnimationClip;
    try {
      clip = THREE.AnimationClip.parse(candidate.clip);
      if (!clip || !Array.isArray(clip.tracks) || clip.tracks.length === 0) {
        return { hit: false, reason: "corrupt_clip_data" };
      }
    } catch {
      return { hit: false, reason: "corrupt_clip_data" };
    }

    return {
      hit: true,
      record: candidate as RetargetCacheRecord,
      clip,
    };
  }

  /**
   * Persists a validated RetargetCacheRecord into cache storage.
   */
  async put(cacheKey: string, record: RetargetCacheRecord): Promise<void> {
    const serialized = JSON.stringify(record, null, 2);
    await this.storage.set(cacheKey, serialized);
  }

  /**
   * Looks up the baked retarget clip in cache, or bakes and persists it on miss/regeneration.
   */
  async getOrBake(options: GetOrBakeOptions): Promise<RetargetBakeCacheResult> {
    const cacheKey = computeRetargetCacheKey({
      sourceAssetHash: options.sourceAssetHash,
      sourceClipId: options.sourceClip.name || options.sourceClip.uuid,
      source: options.sourceProfile,
      target: options.targetProfile,
      settings: options.settings,
      retargetVersion: options.settings?.version ?? 1,
    });

    const cacheIdentity = this.storage.resolveIdentity(cacheKey);
    const lookup = await this.get(cacheKey);

    if (lookup.hit && lookup.record && lookup.clip) {
      const srcSig = skeletonSignature(options.sourceProfile);
      const tgtSig = skeletonSignature(options.targetProfile);
      const srcHash = options.sourceAssetHash ?? "";

      // Validate metadata consistency
      if (
        lookup.record.sourceSkeletonSignature === srcSig &&
        lookup.record.targetSkeletonSignature === tgtSig &&
        lookup.record.sourceAssetHash === srcHash
      ) {
        return {
          success: true,
          cacheHit: true,
          cacheKey,
          cacheIdentity,
          cachePath: cacheIdentity,
          bakedClipName: lookup.clip.name,
          trackCount: lookup.clip.tracks.length,
          duration: lookup.clip.duration,
          clip: lookup.clip,
          record: lookup.record,
          diagnostics: [],
        };
      }
    }

    // Cache MISS or invalidated/corrupt -> execute real retarget baking
    const regenerationReason = lookup.reason !== "miss" ? lookup.reason : undefined;
    const bakeFn = options.bakeFn ?? bakeRetargetedClip;
    const bakeResult = bakeFn(options);

    if (!bakeResult.success || !bakeResult.clip) {
      return {
        success: false,
        cacheHit: false,
        cacheKey,
        cacheIdentity,
        cachePath: cacheIdentity,
        trackCount: 0,
        duration: options.sourceClip.duration,
        diagnostics: bakeResult.diagnostics,
        error: bakeResult.error ?? "Retarget baking failed",
        regenerationReason,
      };
    }

    const record: RetargetCacheRecord = {
      schemaVersion: RETARGET_CACHE_SCHEMA_VERSION,
      cacheKey,
      sourceAssetHash: options.sourceAssetHash ?? "",
      sourceClipId: options.sourceClip.name || options.sourceClip.uuid,
      sourceSkeletonSignature: skeletonSignature(options.sourceProfile),
      targetSkeletonSignature: skeletonSignature(options.targetProfile),
      retargetVersion: options.settings?.version ?? 1,
      clip: bakeResult.clip.toJSON(),
    };

    await this.put(cacheKey, record);

    return {
      success: true,
      cacheHit: false,
      cacheKey,
      cacheIdentity,
      cachePath: cacheIdentity,
      bakedClipName: bakeResult.clip.name,
      trackCount: bakeResult.trackCount,
      duration: bakeResult.duration,
      clip: bakeResult.clip,
      record,
      diagnostics: bakeResult.diagnostics,
      regenerationReason,
    };
  }
}
