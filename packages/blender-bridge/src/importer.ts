import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AssetDiagnostic,
  AssetImporter,
  AssetImporterContext,
  AssetImporterResult,
} from "@kinetra/asset-pipeline";
import { inspectGlb, measureGlbDimensions } from "@kinetra/asset-pipeline";
import {
  BlenderBridgeError,
  type ProcessRunner,
  NodeProcessRunner,
  runBlenderExport,
} from "./index.js";

/** Manifest fields the importer forwards into asset metadata. */
export interface BlenderExportManifestSummary {
  blenderVersion?: string;
  actions?: string[];
  armatures?: string[];
  meshes?: string[];
}

function readStringSetting(
  settings: Record<string, unknown> | undefined,
  key: "blenderExecutable" | "pythonScript",
): string | undefined {
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, key)) return undefined;
  const value = settings[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BlenderBridgeError(
      "blender.invalidOption",
      `Import recipe setting "${key}" must be a non-empty string`,
      { option: key, received: value === null ? "null" : typeof value },
    );
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates the JSON manifest written by export_glb.py. Never throws: fields with
 * the wrong shape are dropped and reported as warning diagnostics.
 */
export function parseBlenderManifest(
  bytes: Uint8Array,
  path: string,
): { manifest?: BlenderExportManifestSummary; diagnostics: AssetDiagnostic[] } {
  const diagnostics: AssetDiagnostic[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    diagnostics.push({
      severity: "warning",
      code: "blender.manifestInvalid",
      message: `Blender export manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      path,
    });
    return { diagnostics };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    diagnostics.push({
      severity: "warning",
      code: "blender.manifestInvalid",
      message: "Blender export manifest must be a JSON object",
      path,
    });
    return { diagnostics };
  }
  const record = raw as Record<string, unknown>;
  const manifest: BlenderExportManifestSummary = {};
  if (record.blenderVersion !== undefined) {
    if (typeof record.blenderVersion === "string") manifest.blenderVersion = record.blenderVersion;
    else
      diagnostics.push({
        severity: "warning",
        code: "blender.manifestFieldInvalid",
        message: 'Blender export manifest field "blenderVersion" must be a string',
        path,
      });
  }
  for (const key of ["actions", "armatures", "meshes"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (isStringArray(value)) manifest[key] = [...value];
    else
      diagnostics.push({
        severity: "warning",
        code: "blender.manifestFieldInvalid",
        message: `Blender export manifest field "${key}" must be an array of strings`,
        path,
      });
  }
  return { manifest, diagnostics };
}

export interface BlenderGlbImporterOptions {
  blenderExecutable?: string;
  pythonScript?: string;
  /**
   * Import recipes are project data, and an agent (or a downloaded project) can write them.
   * `recipe.settings.blenderExecutable` / `pythonScript` therefore only take effect when the host
   * opts in here; otherwise a recipe that sets them is rejected with `blender.invalidOption`
   * before anything is spawned. Default: false.
   */
  allowRecipeExecutableOverrides?: boolean;
  runner?: ProcessRunner;
  /** Wall-clock limit for the default process runner (ignored when `runner` is given). */
  timeoutMs?: number;
  fileSystem?: {
    readFile(path: string): Promise<Uint8Array>;
    /** Removes a staging sidecar; a missing file is not an error. Defaults to node's `rm(force)`. */
    unlink?(path: string): Promise<void>;
  };
}

export function defaultExportScriptPath(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    return resolve(currentDir, "../../python/export_glb.py");
  } catch {
    return resolve("packages/blender-bridge/python/export_glb.py");
  }
}

export class BlenderGlbImporter implements AssetImporter {
  readonly #blenderExecutable: string;
  readonly #pythonScript: string;
  readonly #allowRecipeOverrides: boolean;
  readonly #runner: ProcessRunner;
  readonly #fs: { readFile(path: string): Promise<Uint8Array> };
  readonly #unlink: (path: string) => Promise<void>;

  constructor(options: BlenderGlbImporterOptions = {}) {
    this.#blenderExecutable =
      options.blenderExecutable ??
      process.env.BLENDER_PATH ??
      "blender";
    this.#pythonScript = options.pythonScript ?? defaultExportScriptPath();
    this.#allowRecipeOverrides = options.allowRecipeExecutableOverrides === true;
    this.#runner = options.runner ??
      new NodeProcessRunner(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
    this.#fs = options.fileSystem ?? {
      async readFile(p: string) {
        const buf = await readFile(p);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      },
    };
    const unlinkOption = options.fileSystem?.unlink;
    this.#unlink = unlinkOption
      ? (p) => unlinkOption.call(options.fileSystem, p)
      : options.fileSystem
        ? async () => {} // a custom read-only adapter (tests, in-memory) owns its own files
        : (p) => rm(p, { force: true });
  }

  async import(context: AssetImporterContext): Promise<AssetImporterResult> {
    try {
      return await this.#importStaged(context);
    } finally {
      // export_glb.py leaves "<staging>.manifest.json" (and Blender may leave "<staging>.glb") next to
      // the staging file. The reimport service only removes the staging file itself, so without this
      // every reimport leaves a uniquely named manifest behind in the asset directory.
      await this.#removeStagingSidecars(context.targetPath);
    }
  }

  async #removeStagingSidecars(targetPath: string): Promise<void> {
    for (const path of [`${targetPath}.manifest.json`, `${targetPath}.glb`]) {
      try {
        await this.#unlink(path);
      } catch {
        // best effort: a sidecar that never existed (or is locked) must not fail the import
      }
    }
  }

  async #importStaged(context: AssetImporterContext): Promise<AssetImporterResult> {
    const settings = context.recipe.settings as Record<string, unknown> | undefined;
    const executableOverride = readStringSetting(settings, "blenderExecutable");
    const scriptOverride = readStringSetting(settings, "pythonScript");
    if (!this.#allowRecipeOverrides) {
      for (const [key, value] of [
        ["blenderExecutable", executableOverride],
        ["pythonScript", scriptOverride],
      ] as const) {
        if (value !== undefined) {
          throw new BlenderBridgeError(
            "blender.invalidOption",
            `Import recipe setting "${key}" is not allowed: recipes are project data and must not choose which program runs. ` +
              `Configure the importer (or set allowRecipeExecutableOverrides) instead.`,
            { option: key, reason: "recipeOverrideNotAllowed" },
          );
        }
      }
    }
    const blenderExecutable = executableOverride ?? this.#blenderExecutable;
    const pythonScript = scriptOverride ?? this.#pythonScript;

    // Run Blender export into staging path context.targetPath
    await runBlenderExport(
      {
        blenderExecutable,
        sourceBlend: context.sourcePath,
        outputGlb: context.targetPath,
        pythonScript,
      },
      this.#runner,
    );

    // Read exported GLB bytes from staging path (Blender may append ".glb").
    let artifactBytes: Uint8Array;
    try {
      artifactBytes = await this.#fs.readFile(context.targetPath);
    } catch (err) {
      try {
        artifactBytes = await this.#fs.readFile(`${context.targetPath}.glb`);
      } catch {
        throw new BlenderBridgeError(
          "blender.outputMissing",
          `Blender reported success but no GLB was found at "${context.targetPath}" or "${context.targetPath}.glb": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { targetPath: context.targetPath },
        );
      }
    }

    // Validate GLB header
    inspectGlb(artifactBytes);

    // The manifest is optional; a present but malformed one is reported, not fatal.
    const manifestPath = `${context.targetPath}.manifest.json`;
    let manifestBytes: Uint8Array | undefined;
    try {
      manifestBytes = await this.#fs.readFile(manifestPath);
    } catch {
      manifestBytes = undefined;
    }
    const parsed = manifestBytes ? parseBlenderManifest(manifestBytes, manifestPath) : { diagnostics: [] };

    // Measured bounding-box size of the exported model. When it cannot be measured the field is left
    // out so the record keeps whatever dimensions it already had, never a made-up [1, 1, 1].
    const dimensions = await measureGlbDimensions(artifactBytes);

    return {
      artifactBytes,
      metadata: {
        ...(dimensions ? { dimensions } : {}),
        ...(parsed.manifest ? { custom: { ...parsed.manifest } } : {}),
      },
      diagnostics: parsed.diagnostics,
    };
  }
}
