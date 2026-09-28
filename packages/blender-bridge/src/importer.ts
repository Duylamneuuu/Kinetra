import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AssetImporter,
  AssetImporterContext,
  AssetImporterResult,
} from "@kinetra/asset-pipeline";
import { inspectGlb } from "@kinetra/asset-pipeline";
import {
  type ProcessRunner,
  NodeProcessRunner,
  runBlenderExport,
} from "./index.js";

export interface BlenderGlbImporterOptions {
  blenderExecutable?: string;
  pythonScript?: string;
  runner?: ProcessRunner;
  fileSystem?: {
    readFile(path: string): Promise<Uint8Array>;
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
  readonly #runner: ProcessRunner;
  readonly #fs: { readFile(path: string): Promise<Uint8Array> };

  constructor(options: BlenderGlbImporterOptions = {}) {
    this.#blenderExecutable =
      options.blenderExecutable ??
      process.env.BLENDER_PATH ??
      "blender";
    this.#pythonScript = options.pythonScript ?? defaultExportScriptPath();
    this.#runner = options.runner ?? new NodeProcessRunner();
    this.#fs = options.fileSystem ?? {
      async readFile(p: string) {
        const buf = await readFile(p);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      },
    };
  }

  async import(context: AssetImporterContext): Promise<AssetImporterResult> {
    const blenderExecutable =
      (context.recipe.settings?.blenderExecutable as string | undefined) ??
      this.#blenderExecutable;

    const pythonScript =
      (context.recipe.settings?.pythonScript as string | undefined) ??
      this.#pythonScript;

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

    // Read exported GLB bytes from staging path
    let artifactBytes: Uint8Array;
    try {
      artifactBytes = await this.#fs.readFile(context.targetPath);
    } catch (err) {
      try {
        artifactBytes = await this.#fs.readFile(`${context.targetPath}.glb`);
      } catch {
        throw err;
      }
    }

    // Validate GLB header
    inspectGlb(artifactBytes);

    // Try reading manifest if generated
    let manifest: any = undefined;
    try {
      const manifestPath = `${context.targetPath}.manifest.json`;
      const manifestBytes = await this.#fs.readFile(manifestPath);
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      // Manifest is optional
    }

    return {
      artifactBytes,
      metadata: {
        dimensions: [1, 1, 1],
        ...(manifest
          ? {
              custom: {
                blenderVersion: manifest.blenderVersion,
                actions: manifest.actions,
                armatures: manifest.armatures,
                meshes: manifest.meshes,
              },
            }
          : {}),
      },
      diagnostics: [],
    };
  }
}
