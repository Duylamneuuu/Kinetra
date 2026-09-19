import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stable((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}

export function hashJson(value: unknown): string {
  return hashBytes(Buffer.from(JSON.stringify(stable(value))));
}

export function importFingerprint(input: {
  sourceHash: string;
  importer: string;
  importerVersion: string;
  settings: Record<string, unknown>;
  dependencyFingerprints?: string[];
}): string {
  return hashJson({
    sourceHash: input.sourceHash,
    importer: input.importer,
    importerVersion: input.importerVersion,
    settings: input.settings,
    dependencies: [...(input.dependencyFingerprints ?? [])].sort(),
  });
}
