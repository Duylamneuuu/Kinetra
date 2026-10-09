import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type CanonicalJsonErrorCode =
  | "hash.nonFiniteNumber"
  | "hash.cycle"
  | "hash.unsupportedValue";

/** Thrown when a value cannot be given one unambiguous canonical JSON form. */
export class CanonicalJsonError extends Error {
  constructor(
    readonly code: CanonicalJsonErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Canonical form used for fingerprints: object keys sorted, own "__proto__" keys preserved, and
 * values JSON.stringify would silently collapse (NaN/Infinity -> null, undefined array items -> null,
 * Date -> {}) rejected or normalised so two different inputs never share a fingerprint.
 */
function stable(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("hash.nonFiniteNumber", path, `Cannot hash non-finite number ${String(value)}`);
    }
    return value;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "undefined" || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new CanonicalJsonError("hash.unsupportedValue", path, `Cannot hash a ${typeof value} value`);
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new CanonicalJsonError("hash.cycle", path, "Cannot hash a circular structure");
  }
  const toJson = (object as { toJSON?: unknown }).toJSON;
  ancestors.add(object);
  try {
    if (typeof toJson === "function") {
      return stable((toJson as () => unknown).call(object), path, ancestors);
    }
    if (Array.isArray(object)) {
      return object.map((item, index) => stable(item, `${path}[${index}]`, ancestors));
    }
    // Null-prototype result: assigning "__proto__" creates an own key instead of swapping the prototype
    // (which JSON.stringify would then drop, hashing {"__proto__": x} the same as {}).
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const record = object as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      // Matches JSON.stringify: an undefined property is the same as an absent one.
      if (record[key] === undefined) continue;
      result[key] = stable(record[key], `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(object);
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
  return hashBytes(await readFile(path));
}

export function hashJson(value: unknown): string {
  return hashBytes(Buffer.from(JSON.stringify(stable(value, "$", new Set()))));
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
