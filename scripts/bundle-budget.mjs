import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const BUDGET_METRICS = Object.freeze([
  "totalJsRawBytes",
  "totalJsGzipBytes",
  "largestJsGzipBytes",
  "initialJsGzipBytes",
]);

/**
 * Names of the JavaScript chunks the entry HTML loads eagerly: module
 * scripts and modulepreload links. Chunks reached only through dynamic
 * import() (Rapier, Recast) are deliberately excluded - they are not on
 * the startup path.
 */
export function findInitialChunks(html) {
  const names = new Set();
  const tagPattern = /<(script|link)\b[^>]*>/gi;
  for (const [tag, kind] of [...html.matchAll(tagPattern)].map((m) => [m[0], m[1].toLowerCase()])) {
    const isScript = kind === "script" && /\btype\s*=\s*["']module["']/i.test(tag);
    const isPreload = kind === "link" && /\brel\s*=\s*["']modulepreload["']/i.test(tag);
    if (!isScript && !isPreload) continue;
    const attr = isScript ? "src" : "href";
    const match = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag);
    if (!match) continue;
    const path = match[1].split(/[?#]/)[0];
    if (!path.endsWith(".js")) continue;
    names.add(path.slice(path.lastIndexOf("/") + 1));
  }
  return [...names].sort();
}

/**
 * Measure the JavaScript chunks of a built bundle directory.
 * Source maps and non-JS assets are ignored. Gzip uses level 9 so the
 * number is stable across machines for the same input bytes.
 */
export async function measureBundle(assetsDir) {
  let entries;
  try {
    entries = await readdir(assetsDir);
  } catch (error) {
    throw Object.assign(new Error(`Bundle assets directory not found: ${assetsDir}`), {
      code: "bundle.assetsMissing",
      cause: error,
    });
  }

  const files = [];
  for (const name of entries.filter((entry) => entry.endsWith(".js")).sort()) {
    const path = join(assetsDir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    const bytes = await readFile(path);
    files.push({
      name,
      rawBytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 9 }).length,
    });
  }

  if (files.length === 0) {
    throw Object.assign(new Error(`No JavaScript chunks found in ${assetsDir}`), {
      code: "bundle.noChunks",
    });
  }
  return files;
}

/**
 * Pure budget evaluation over measured chunks.
 * Returns { ok, metrics, violations } where each violation names the metric,
 * the actual value, and the budget it exceeded.
 */
export function evaluateBundleBudget(files, budgets, initialChunkNames) {
  if (!Array.isArray(files) || files.length === 0) {
    throw Object.assign(new Error("evaluateBundleBudget requires at least one chunk"), {
      code: "bundle.noChunks",
    });
  }
  for (const key of Object.keys(budgets ?? {})) {
    if (!BUDGET_METRICS.includes(key)) {
      throw Object.assign(new Error(`Unknown bundle budget metric: ${key}`), {
        code: "bundle.unknownMetric",
      });
    }
    const value = budgets[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw Object.assign(new Error(`Budget ${key} must be a positive integer, got ${String(value)}`), {
        code: "bundle.invalidBudget",
      });
    }
  }

  const metrics = {
    totalJsRawBytes: files.reduce((sum, file) => sum + file.rawBytes, 0),
    totalJsGzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    largestJsGzipBytes: Math.max(...files.map((file) => file.gzipBytes)),
  };

  if (initialChunkNames !== undefined) {
    const initial = files.filter((file) => initialChunkNames.includes(file.name));
    if (initial.length !== initialChunkNames.length) {
      throw Object.assign(new Error("Entry HTML references a JavaScript chunk that is not in the bundle"), {
        code: "bundle.initialChunkMissing",
      });
    }
    metrics.initialJsGzipBytes = initial.reduce((sum, file) => sum + file.gzipBytes, 0);
  } else if (budgets?.initialJsGzipBytes !== undefined) {
    throw Object.assign(new Error("initialJsGzipBytes budget requires the entry HTML chunk list"), {
      code: "bundle.initialChunksUnknown",
    });
  }

  const violations = BUDGET_METRICS.filter(
    (metric) => budgets?.[metric] !== undefined && metrics[metric] > budgets[metric],
  ).map((metric) => ({
    code: "bundle.budgetExceeded",
    metric,
    actual: metrics[metric],
    budget: budgets[metric],
  }));

  return { ok: violations.length === 0, metrics, violations };
}
