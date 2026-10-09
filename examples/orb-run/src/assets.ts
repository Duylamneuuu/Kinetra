import {
  AssetDatabase,
  AssetReimportService,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  inspectGlb,
  normalizeGlb,
  validateAssetRecord,
  type AssetDiagnostic,
  type AssetImporter,
  type AssetImporterContext,
  type AssetImporterResult,
  type AssetMetadata,
  type AssetRecord,
  type FileSystemAdapter,
  type ReimportEvent,
  type ReimportResult,
} from "@kinetra/asset-pipeline";
import { createOrbRunAudioBytes, ORB_RUN_AUDIO_ASSET_IDS, orbRunClipDuration } from "./audio.js";

/**
 * Orb Run content through Kinetra's asset pipeline.
 *
 * Every model and audio clip is generated from code (no binary files in the
 * repo), registered as an `AssetRecord` with provenance, and imported by the
 * engine's own `AssetReimportService` onto an in-memory file system, so the
 * whole import → validate → fingerprint → reimport loop runs in plain Node
 * and is deterministic. Nothing here touches disk.
 */

export const ORB_RUN_MODEL_ASSET = {
  orb: "asset_orbrun_model_orb",
  exitPad: "asset_orbrun_model_exit_pad",
  player: "asset_orbrun_model_player",
} as const;

export const ORB_RUN_MODEL_ASSET_IDS: readonly string[] = Object.values(ORB_RUN_MODEL_ASSET).sort();

/** Every asset Orb Run ships: models then audio, each group sorted. */
export const ORB_RUN_ASSET_IDS: readonly string[] = [...ORB_RUN_MODEL_ASSET_IDS, ...ORB_RUN_AUDIO_ASSET_IDS];

export const ORB_RUN_GLB_IMPORTER = "orbrun-glb";
export const ORB_RUN_WAV_IMPORTER = "orbrun-wav";
export const ORB_RUN_IMPORTER_VERSION = "1";

interface ModelSpec {
  name: string;
  size: [number, number, number];
  color: [number, number, number, number];
}

const MODEL_SPECS: Record<string, ModelSpec> = {
  [ORB_RUN_MODEL_ASSET.orb]: { name: "Orb", size: [0.6, 0.6, 0.6], color: [1, 0.72, 0.1, 1] },
  [ORB_RUN_MODEL_ASSET.exitPad]: { name: "ExitPad", size: [2, 0.1, 2], color: [0.15, 0.85, 0.35, 1] },
  [ORB_RUN_MODEL_ASSET.player]: { name: "Runner", size: [0.6, 1.7, 0.6], color: [0.2, 0.45, 0.95, 1] },
};

/** A unit box has 12 triangles; the synthetic generator only makes boxes. */
const BOX_TRIANGLES = 12;

export type OrbRunAssetSources = Record<string, Uint8Array>;

/** Deterministic GLB bytes for one Orb Run model. `color` overrides the authored colour (to simulate an artist edit). */
export async function createOrbRunModelBytes(
  assetId: string,
  override: { color?: [number, number, number, number] } = {},
): Promise<Uint8Array> {
  const spec = MODEL_SPECS[assetId];
  if (!spec) throw new RangeError(`Unknown Orb Run model asset "${assetId}"`);
  return createSyntheticGlb({
    meshName: `${spec.name}Mesh`,
    nodeName: spec.name,
    materialName: `${spec.name}Material`,
    size: spec.size,
    color: override.color ?? spec.color,
  });
}

/** Source bytes (the "artist files") for every Orb Run asset, keyed by asset id. */
export async function createOrbRunAssetSources(): Promise<OrbRunAssetSources> {
  const sources: OrbRunAssetSources = {};
  for (const id of ORB_RUN_MODEL_ASSET_IDS) sources[id] = await createOrbRunModelBytes(id);
  Object.assign(sources, createOrbRunAudioBytes());
  return sources;
}

export function orbRunSourcePath(assetId: string): string {
  return `assets/source/${assetId}.${assetId in MODEL_SPECS ? "glb" : "wav"}`;
}

export function orbRunImportedPath(assetId: string): string {
  return `assets/imported/${assetId}.${assetId in MODEL_SPECS ? "glb" : "wav"}`;
}

function modelMetadata(spec: ModelSpec): AssetRecord["metadata"] {
  const [x, y, z] = spec.size;
  return {
    polycount: BOX_TRIANGLES,
    dimensions: [x, y, z],
    boundsRadius: Math.round((Math.hypot(x, y, z) / 2) * 1e6) / 1e6,
    provenance: { provider: "kinetra-synthetic", generator: "createSyntheticGlb", license: "CC0-1.0" },
  };
}

/** The asset database records Orb Run registers before the first import. */
export function createOrbRunAssetRecords(sources: OrbRunAssetSources): AssetRecord[] {
  const records: AssetRecord[] = [];
  for (const id of ORB_RUN_ASSET_IDS) {
    const bytes = sources[id];
    if (!bytes) throw new Error(`Missing source bytes for Orb Run asset "${id}"`);
    const spec = MODEL_SPECS[id];
    const importer = spec ? ORB_RUN_GLB_IMPORTER : ORB_RUN_WAV_IMPORTER;
    const settings: Record<string, unknown> = spec ? { size: spec.size } : { sampleRateHz: 22050 };
    const contentHash = hashBytes(bytes);
    records.push({
      id,
      kind: spec ? "model" : "audio",
      source: { path: orbRunSourcePath(id), kind: "generated", contentHash },
      importedPath: orbRunImportedPath(id),
      recipe: { importer, importerVersion: ORB_RUN_IMPORTER_VERSION, settings },
      fingerprint: importFingerprint({
        sourceHash: contentHash,
        importer,
        importerVersion: ORB_RUN_IMPORTER_VERSION,
        settings,
      }),
      dependencies: [],
      diagnostics: [],
      metadata: spec
        ? modelMetadata(spec)
        : {
            durationSeconds: orbRunClipDuration(id),
            provenance: { provider: "kinetra-synthetic", generator: "createSyntheticWav", license: "CC0-1.0" },
          },
    });
  }
  return records;
}

/**
 * GLB importer for Orb Run: validates the header, re-writes the file through
 * glTF-Transform (`normalizeGlb`) and records the authored dimensions/polycount.
 *
 * The engine's built-in `glb` importer (`GlbDirectImporter`) stamps a hard-coded
 * `dimensions: [1, 1, 1]` on every model, so a game that wants true metadata
 * has to bring its own importer (see "Engine requests" in README.md).
 */
export class OrbRunGlbImporter implements AssetImporter {
  async import(context: AssetImporterContext): Promise<AssetImporterResult> {
    inspectGlb(context.sourceBytes);
    const normalized = await normalizeGlb(context.sourceBytes);
    if (normalized.meshCount < 1) throw new Error(`Model "${context.assetId}" contains no mesh`);
    const size = context.recipe.settings.size as [number, number, number] | undefined;
    const metadata: Partial<AssetMetadata> = { polycount: BOX_TRIANGLES * normalized.meshCount };
    if (size) {
      metadata.dimensions = [size[0], size[1], size[2]];
      metadata.boundsRadius = Math.round((Math.hypot(size[0], size[1], size[2]) / 2) * 1e6) / 1e6;
    }
    return { artifactBytes: normalized.bytes, metadata };
  }
}

/** PCM WAV importer: checks the RIFF/WAVE header and reads the sample rate. */
export class OrbRunWavImporter implements AssetImporter {
  async import(context: AssetImporterContext): Promise<AssetImporterResult> {
    const bytes = context.sourceBytes;
    const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
      throw new Error(`Audio asset "${context.assetId}" is not a RIFF/WAVE file`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleRateHz = view.getUint32(24, true);
    const diagnostics: AssetDiagnostic[] = [];
    const expected = context.recipe.settings.sampleRateHz;
    if (typeof expected === "number" && expected !== sampleRateHz) {
      diagnostics.push({
        severity: "warning",
        code: "orbrun.audio.sampleRate",
        message: `Expected ${expected} Hz, file is ${sampleRateHz} Hz`,
      });
    }
    return { artifactBytes: bytes, metadata: { sampleRateHz }, diagnostics };
  }
}

/** In-memory `FileSystemAdapter` that counts writes, for deterministic pipeline tests. */
export class MemoryFileSystem implements FileSystemAdapter {
  readonly files = new Map<string, Uint8Array>();
  writeCount = 0;

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw Object.assign(new Error(`ENOENT: no such file "${path}"`), { code: "ENOENT" });
    return bytes;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.writeCount += 1;
    this.files.set(path, new Uint8Array(data));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const bytes = await this.readFile(oldPath);
    this.files.set(newPath, bytes);
    this.files.delete(oldPath);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }

  async mkdir(): Promise<string | undefined> {
    return undefined;
  }
}

export interface OrbRunAssetPipeline {
  database: AssetDatabase;
  fileSystem: MemoryFileSystem;
  service: AssetReimportService;
  events: ReimportEvent[];
  sources: OrbRunAssetSources;
}

/** Register every Orb Run asset (sources in the in-memory file system) without importing yet. */
export async function createOrbRunAssetPipeline(): Promise<OrbRunAssetPipeline> {
  const sources = await createOrbRunAssetSources();
  const fileSystem = new MemoryFileSystem();
  for (const id of ORB_RUN_ASSET_IDS) fileSystem.files.set(orbRunSourcePath(id), sources[id]!);
  const database = new AssetDatabase({ schemaVersion: 1, assets: createOrbRunAssetRecords(sources) });
  const events: ReimportEvent[] = [];
  const service = new AssetReimportService({
    database,
    fileSystem,
    importers: new Map<string, AssetImporter>([
      [ORB_RUN_GLB_IMPORTER, new OrbRunGlbImporter()],
      [ORB_RUN_WAV_IMPORTER, new OrbRunWavImporter()],
    ]),
    onEvent: (event) => events.push(event),
  });
  return { database, fileSystem, service, events, sources };
}

/** Import every asset once, in id order. */
export async function importOrbRunAssets(pipeline: OrbRunAssetPipeline): Promise<ReimportResult[]> {
  const results: ReimportResult[] = [];
  for (const id of ORB_RUN_ASSET_IDS) results.push(await pipeline.service.reimport(id));
  return results;
}

/** `createOrbRunAssetPipeline()` + `importOrbRunAssets()`. */
export async function buildOrbRunAssets(): Promise<OrbRunAssetPipeline & { results: ReimportResult[] }> {
  const pipeline = await createOrbRunAssetPipeline();
  return { ...pipeline, results: await importOrbRunAssets(pipeline) };
}

/** Validator diagnostics for every record, plus a check that each imported artifact exists. */
export function validateOrbRunAssets(pipeline: Pick<OrbRunAssetPipeline, "database" | "fileSystem">): AssetDiagnostic[] {
  const diagnostics: AssetDiagnostic[] = [];
  for (const record of pipeline.database.list()) {
    for (const diagnostic of validateAssetRecord(record)) {
      diagnostics.push({ ...diagnostic, path: diagnostic.path ?? record.id });
    }
    if (!pipeline.fileSystem.files.has(record.importedPath)) {
      diagnostics.push({
        severity: "error",
        code: "orbrun.asset.artifactMissing",
        message: `Imported artifact "${record.importedPath}" does not exist`,
        path: record.id,
      });
    }
  }
  return diagnostics;
}

export interface OrbRunAssetReportRow {
  id: string;
  kind: AssetRecord["kind"];
  importedPath: string;
  fingerprint: string;
  bytes: number;
}

/** Stable one-row-per-asset summary (id order) of the imported content. */
export function orbRunAssetReport(pipeline: Pick<OrbRunAssetPipeline, "database" | "fileSystem">): OrbRunAssetReportRow[] {
  return pipeline.database.list().map((record) => ({
    id: record.id,
    kind: record.kind,
    importedPath: record.importedPath,
    fingerprint: record.fingerprint,
    bytes: pipeline.fileSystem.files.get(record.importedPath)?.byteLength ?? 0,
  }));
}

export type OrbRunAssetImportStatus = "imported" | "failed" | "pending";

export interface OrbRunAssetState {
  kind: AssetRecord["kind"];
  importStatus: OrbRunAssetImportStatus;
  /** How many real (non-noop) imports succeeded; 1 after the first import. */
  revision: number;
  fingerprint: string;
  sourceHash: string;
  importedPath: string;
  bytes: number;
  polycount?: number;
  dimensions?: [number, number, number];
  sampleRateHz?: number;
  durationSeconds?: number;
  /** Why the last import failed; the artifact above is still the last good one. */
  error?: string;
}

export interface OrbRunAssetsState {
  count: number;
  modelCount: number;
  audioCount: number;
  importedCount: number;
  failedCount: number;
  /** Validator errors (and missing artifacts) across the whole database. */
  errorCount: number;
  /** Validator warnings plus importer diagnostics warnings across the whole database. */
  warningCount: number;
  /** Real reimports after the first import (artist edits that went through). */
  reimportCount: number;
  /** Cues the game played whose asset is not in the database (content the game cannot ship). */
  unregisteredCues: number;
  byId: Record<string, OrbRunAssetState>;
}

export interface OrbRunAssetFailure {
  assetId: string;
  error: string;
}

/**
 * The content the running game ships, as the asset pipeline sees it: every
 * Orb Run asset imported once, plus hot-reimport of an edited source with the
 * pipeline's last-known-good guarantee. The acceptance probe exposes it as
 * `state.assets.*`.
 */
export class OrbRunAssetCatalog {
  readonly #pipeline: OrbRunAssetPipeline;
  readonly #revisions = new Map<string, number>();
  readonly #pendingErrors = new Map<string, string>();
  readonly #failureLog: OrbRunAssetFailure[] = [];

  private constructor(pipeline: OrbRunAssetPipeline) {
    this.#pipeline = pipeline;
  }

  /** Builds the pipeline and imports every asset (a failure here is a bug in the sample content, so it throws). */
  static async create(): Promise<OrbRunAssetCatalog> {
    const pipeline = await createOrbRunAssetPipeline();
    const catalog = new OrbRunAssetCatalog(pipeline);
    for (const result of await importOrbRunAssets(pipeline)) {
      if (result.status === "failed") {
        throw new Error(`Orb Run asset "${result.assetId}" failed its first import: ${result.error ?? "unknown error"}`);
      }
      catalog.#record(result);
    }
    return catalog;
  }

  get pipeline(): OrbRunAssetPipeline {
    return this.#pipeline;
  }

  has(assetId: string): boolean {
    return this.#pipeline.database.get(assetId) !== undefined;
  }

  /**
   * An artist saved new source bytes for `assetId`: write them and reimport.
   * Unknown ids throw (a manifest that names a typo must not pass). A bad file
   * does not throw: the import fails, the last good artifact stays, and the
   * failure shows up in `state.assets.byId.<id>` and `failures()`.
   */
  async replaceSource(assetId: string, bytes: Uint8Array): Promise<ReimportResult> {
    const record = this.#pipeline.database.get(assetId);
    if (!record) throw new RangeError(`Unknown Orb Run asset "${assetId}"`);
    await this.#pipeline.fileSystem.writeFile(record.source.path, bytes);
    const result = await this.#pipeline.service.reimport(assetId);
    this.#record(result);
    return result;
  }

  failures(): OrbRunAssetFailure[] {
    return this.#failureLog.map((entry) => ({ ...entry }));
  }

  state(playedAssetIds: readonly string[] = []): OrbRunAssetsState {
    const { database, fileSystem } = this.#pipeline;
    const records = database.list();
    const byId: Record<string, OrbRunAssetState> = {};
    let errorCount = 0;
    let warningCount = 0;
    let reimportCount = 0;
    for (const record of records) {
      const pendingError = this.#pendingErrors.get(record.id);
      const revision = this.#revisions.get(record.id) ?? 0;
      reimportCount += Math.max(0, revision - 1);
      const artifact = fileSystem.files.get(record.importedPath);
      const diagnostics = [...validateAssetRecord(record), ...record.diagnostics];
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === "error") errorCount += 1;
        else if (diagnostic.severity === "warning") warningCount += 1;
      }
      if (!artifact) errorCount += 1;
      const { dimensions, polycount } = record.metadata;
      const sampleRateHz = record.metadata["sampleRateHz"];
      const durationSeconds = record.metadata["durationSeconds"];
      byId[record.id] = {
        kind: record.kind,
        importStatus: pendingError ? "failed" : artifact ? "imported" : "pending",
        revision,
        fingerprint: record.fingerprint,
        sourceHash: record.source.contentHash,
        importedPath: record.importedPath,
        bytes: artifact?.byteLength ?? 0,
        ...(polycount !== undefined ? { polycount } : {}),
        ...(dimensions ? { dimensions: [dimensions[0], dimensions[1], dimensions[2]] as [number, number, number] } : {}),
        ...(typeof sampleRateHz === "number" ? { sampleRateHz } : {}),
        ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
        ...(pendingError ? { error: pendingError } : {}),
      };
    }
    const states = Object.values(byId);
    return {
      count: records.length,
      modelCount: states.filter((s) => s.kind === "model").length,
      audioCount: states.filter((s) => s.kind === "audio").length,
      importedCount: states.filter((s) => s.importStatus === "imported").length,
      failedCount: states.filter((s) => s.importStatus === "failed").length,
      errorCount,
      warningCount,
      reimportCount,
      unregisteredCues: playedAssetIds.filter((id) => !database.get(id)).length,
      byId,
    };
  }

  #record(result: ReimportResult): void {
    if (result.status === "failed") {
      const error = result.error ?? "import failed";
      this.#pendingErrors.set(result.assetId, error);
      this.#failureLog.push({ assetId: result.assetId, error });
      return;
    }
    this.#pendingErrors.delete(result.assetId);
    if (result.status === "reimported") {
      this.#revisions.set(result.assetId, (this.#revisions.get(result.assetId) ?? 0) + 1);
    }
  }
}
