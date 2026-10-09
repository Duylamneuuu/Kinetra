import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { calculateVisualEvidence, hammingDistance } from "./visual.js";

/**
 * Long-term visual baseline management (issue #100).
 *
 * A baseline file stores, per named frame, the PNG's sha256 plus its 64-bit
 * difference hash (dHash) and dimensions. Frames are compared against the
 * baseline by dHash distance, so tiny rasteriser differences do not fail a
 * run, while a byte-identical frame is reported as `identical`.
 *
 * Rules:
 * - `checkVisualBaselines` never writes anything and never changes a baseline.
 * - `updateVisualBaselines` is the only way to change a baseline. It needs an
 *   explicit `confirm: true` and refuses to run when the environment looks
 *   like CI, so CI can never auto-accept a regression.
 * - Everything is deterministic: entries are sorted by name (code-unit order),
 *   serialisation is canonical, reports contain no timestamps.
 */

export const VISUAL_BASELINE_SCHEMA_VERSION = 1;

/** Default dHash distance (out of 64 bits) a frame may drift from its baseline. */
export const DEFAULT_BASELINE_HASH_TOLERANCE = 8;

export type VisualBaselineErrorCode =
  | "baseline.invalidFile"
  | "baseline.invalidName"
  | "baseline.invalidOption"
  | "baseline.duplicateFrame"
  | "baseline.updateNotConfirmed"
  | "baseline.updateForbiddenInCi"
  | "baseline.ioFailed";

export class VisualBaselineError extends Error {
  readonly code: VisualBaselineErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: VisualBaselineErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "VisualBaselineError";
    this.code = code;
    this.details = details;
  }
}

export interface VisualBaselineEntry {
  name: string;
  sha256: string;
  /** 16 hex characters, see `dHash`. */
  perceptualHash: string;
  width: number;
  height: number;
}

export interface VisualBaselineFile {
  schemaVersion: typeof VISUAL_BASELINE_SCHEMA_VERSION;
  /** Sorted by `name` in code-unit order, names unique. */
  entries: VisualBaselineEntry[];
}

export interface VisualFrame {
  name: string;
  bytes: Uint8Array;
}

export type VisualBaselineStatus =
  /** Same PNG bytes as the baseline. */
  | "identical"
  /** Different bytes, same size, dHash within tolerance. */
  | "similar"
  /** Size changed or dHash beyond tolerance. */
  | "mismatch"
  /** No baseline recorded for this frame yet. */
  | "missing";

export interface VisualBaselineResult {
  name: string;
  status: VisualBaselineStatus;
  passed: boolean;
  expected?: VisualBaselineEntry | undefined;
  actual: VisualBaselineEntry;
  /** dHash Hamming distance; undefined when there is no baseline. */
  hashDistance?: number | undefined;
  /** Human-readable reasons a frame failed (empty when it passed). */
  reasons: string[];
}

export interface VisualBaselineReport {
  passed: boolean;
  tolerance: number;
  results: VisualBaselineResult[];
  /** Baselines nobody supplied a frame for (informational, never a failure). */
  unusedBaselines: string[];
}

export interface VisualBaselineCheckOptions {
  /** dHash distance in [0, 64] a frame may drift. Default 8. */
  maxPerceptualHashDistance?: number | undefined;
}

export interface VisualBaselineUpdateOptions {
  /** Must be exactly `true`: the explicit "I mean to change the baselines" switch. */
  confirm: boolean;
  /** Environment to inspect for CI markers. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Only update these frame names (others are untouched). Default: every supplied frame. */
  only?: readonly string[] | undefined;
}

export interface VisualBaselineUpdateResult {
  file: VisualBaselineFile;
  added: string[];
  updated: string[];
  unchanged: string[];
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{16}$/;

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function assertValidBaselineName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new VisualBaselineError(
      "baseline.invalidName",
      `frame name must match ${String(NAME_PATTERN)} (got ${JSON.stringify(name)})`,
      { name },
    );
  }
}

function resolveTolerance(options: VisualBaselineCheckOptions | undefined): number {
  const value = options?.maxPerceptualHashDistance;
  if (value === undefined) {
    return DEFAULT_BASELINE_HASH_TOLERANCE;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 64) {
    throw new VisualBaselineError(
      "baseline.invalidOption",
      `maxPerceptualHashDistance must be a finite number in [0, 64] (got ${String(value)})`,
      { value },
    );
  }
  return value;
}

/** Creates an empty baseline file. */
export function createVisualBaselineFile(): VisualBaselineFile {
  return { schemaVersion: VISUAL_BASELINE_SCHEMA_VERSION, entries: [] };
}

/** Computes the baseline entry (hashes + size) for a named PNG frame. */
export function createVisualBaselineEntry(name: string, bytes: Uint8Array): VisualBaselineEntry {
  assertValidBaselineName(name);
  const evidence = calculateVisualEvidence(bytes);
  return {
    name,
    sha256: evidence.sha256,
    perceptualHash: evidence.perceptualHash.toLowerCase(),
    width: evidence.width,
    height: evidence.height,
  };
}

function invalidFile(message: string, details: Record<string, unknown> = {}): never {
  throw new VisualBaselineError("baseline.invalidFile", message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates a baseline file's JSON text. Anything malformed throws a
 * `baseline.invalidFile` error rather than yielding a baseline that silently
 * matches everything.
 */
export function parseVisualBaselineFile(text: string): VisualBaselineFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalidFile(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    return invalidFile("top level must be an object");
  }
  if (parsed.schemaVersion !== VISUAL_BASELINE_SCHEMA_VERSION) {
    return invalidFile(
      `schemaVersion must be ${VISUAL_BASELINE_SCHEMA_VERSION} (got ${JSON.stringify(parsed.schemaVersion)})`,
      { schemaVersion: parsed.schemaVersion },
    );
  }
  if (!Array.isArray(parsed.entries)) {
    return invalidFile("entries must be an array");
  }
  const seen = new Set<string>();
  const entries: VisualBaselineEntry[] = [];
  for (const [index, raw] of parsed.entries.entries()) {
    if (!isRecord(raw)) {
      return invalidFile(`entries[${index}] must be an object`, { index });
    }
    const { name, sha256, perceptualHash, width, height } = raw;
    try {
      assertValidBaselineName(name);
    } catch {
      return invalidFile(`entries[${index}].name is invalid (${JSON.stringify(name)})`, { index });
    }
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
      return invalidFile(`entries[${index}].sha256 must be 64 lowercase hex characters`, { index, name });
    }
    if (typeof perceptualHash !== "string" || !HASH_PATTERN.test(perceptualHash)) {
      return invalidFile(`entries[${index}].perceptualHash must be 16 lowercase hex characters`, { index, name });
    }
    if (!Number.isSafeInteger(width) || (width as number) <= 0 || !Number.isSafeInteger(height) || (height as number) <= 0) {
      return invalidFile(`entries[${index}] width/height must be positive integers`, { index, name });
    }
    if (seen.has(name)) {
      return invalidFile(`duplicate baseline "${name}"`, { index, name });
    }
    seen.add(name);
    entries.push({ name, sha256, perceptualHash, width: width as number, height: height as number });
  }
  entries.sort((a, b) => compareNames(a.name, b.name));
  return { schemaVersion: VISUAL_BASELINE_SCHEMA_VERSION, entries };
}

/** Canonical JSON text of a baseline file (sorted, 2-space indent, trailing newline). */
export function serializeVisualBaselineFile(file: VisualBaselineFile): string {
  const entries = [...file.entries]
    .sort((a, b) => compareNames(a.name, b.name))
    .map((entry) => ({
      name: entry.name,
      sha256: entry.sha256,
      perceptualHash: entry.perceptualHash,
      width: entry.width,
      height: entry.height,
    }));
  return `${JSON.stringify({ schemaVersion: VISUAL_BASELINE_SCHEMA_VERSION, entries }, null, 2)}\n`;
}

function indexFrames(frames: readonly VisualFrame[]): Map<string, VisualBaselineEntry> {
  const result = new Map<string, VisualBaselineEntry>();
  for (const frame of frames) {
    assertValidBaselineName(frame.name);
    if (result.has(frame.name)) {
      throw new VisualBaselineError("baseline.duplicateFrame", `frame "${frame.name}" supplied more than once`, {
        name: frame.name,
      });
    }
    result.set(frame.name, createVisualBaselineEntry(frame.name, frame.bytes));
  }
  return result;
}

/**
 * Checks frames against a baseline. Pure: nothing is written and the baseline is
 * never modified. A frame without a baseline is a failure (`missing`), so a new
 * frame cannot slip through un-reviewed.
 */
export function checkVisualBaselines(
  baseline: VisualBaselineFile,
  frames: readonly VisualFrame[],
  options?: VisualBaselineCheckOptions,
): VisualBaselineReport {
  const tolerance = resolveTolerance(options);
  const actuals = indexFrames(frames);
  const expectedByName = new Map(baseline.entries.map((entry) => [entry.name, entry] as const));
  const results: VisualBaselineResult[] = [];
  for (const name of [...actuals.keys()].sort(compareNames)) {
    const actual = actuals.get(name)!;
    const expected = expectedByName.get(name);
    if (!expected) {
      results.push({
        name,
        status: "missing",
        passed: false,
        actual,
        reasons: [`no baseline recorded for "${name}"; run the explicit update command to accept it`],
      });
      continue;
    }
    const hashDistance = hammingDistance(expected.perceptualHash, actual.perceptualHash);
    const reasons: string[] = [];
    if (expected.width !== actual.width || expected.height !== actual.height) {
      reasons.push(
        `size changed from ${expected.width}x${expected.height} to ${actual.width}x${actual.height}`,
      );
    }
    if (hashDistance > tolerance) {
      reasons.push(`perceptual hash distance ${hashDistance} exceeds tolerance ${tolerance}`);
    }
    let status: VisualBaselineStatus;
    if (reasons.length > 0) {
      status = "mismatch";
    } else if (expected.sha256 === actual.sha256) {
      status = "identical";
    } else {
      status = "similar";
    }
    results.push({ name, status, passed: reasons.length === 0, expected, actual, hashDistance, reasons });
  }
  const unusedBaselines = baseline.entries
    .map((entry) => entry.name)
    .filter((name) => !actuals.has(name))
    .sort(compareNames);
  return {
    passed: results.every((result) => result.passed),
    tolerance,
    results,
    unusedBaselines,
  };
}

/** True when the environment carries a CI marker (CI set to anything but ""/0/false, or GITHUB_ACTIONS=true). */
export function isCiEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const ci = env.CI;
  if (ci !== undefined) {
    const normalised = ci.trim().toLowerCase();
    if (normalised !== "" && normalised !== "0" && normalised !== "false") {
      return true;
    }
  }
  return env.GITHUB_ACTIONS?.trim().toLowerCase() === "true";
}

/**
 * The only function that changes a baseline. Requires `confirm: true`, refuses
 * under CI, and returns a new file (the input is never mutated). Frames that are
 * not named in `only` (when given) are ignored; baselines nobody supplied a frame
 * for are kept as they are.
 */
export function updateVisualBaselines(
  baseline: VisualBaselineFile,
  frames: readonly VisualFrame[],
  options: VisualBaselineUpdateOptions,
): VisualBaselineUpdateResult {
  if (options.confirm !== true) {
    throw new VisualBaselineError(
      "baseline.updateNotConfirmed",
      "updating baselines requires confirm: true (the explicit update command)",
    );
  }
  if (isCiEnvironment(options.env ?? process.env)) {
    throw new VisualBaselineError(
      "baseline.updateForbiddenInCi",
      "visual baselines are never updated in CI; regenerate them locally and commit the result",
    );
  }
  const onlyNames = options.only === undefined ? undefined : new Set(options.only);
  if (onlyNames) {
    for (const name of onlyNames) {
      assertValidBaselineName(name);
    }
  }
  const actuals = indexFrames(frames);
  if (onlyNames) {
    for (const name of onlyNames) {
      if (!actuals.has(name)) {
        throw new VisualBaselineError("baseline.invalidOption", `"only" names "${name}" but no such frame was supplied`, {
          name,
        });
      }
    }
  }
  const next = new Map(baseline.entries.map((entry) => [entry.name, entry] as const));
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const name of [...actuals.keys()].sort(compareNames)) {
    if (onlyNames && !onlyNames.has(name)) {
      continue;
    }
    const actual = actuals.get(name)!;
    const previous = next.get(name);
    if (!previous) {
      added.push(name);
    } else if (previous.sha256 === actual.sha256) {
      unchanged.push(name);
      continue;
    } else {
      updated.push(name);
    }
    next.set(name, actual);
  }
  return {
    file: {
      schemaVersion: VISUAL_BASELINE_SCHEMA_VERSION,
      entries: [...next.values()].sort((a, b) => compareNames(a.name, b.name)),
    },
    added,
    updated,
    unchanged,
  };
}

/** Plain-text/markdown diff report. Deterministic: no timestamps or paths. */
export function formatVisualBaselineReport(report: VisualBaselineReport): string {
  const lines: string[] = [];
  const failed = report.results.filter((result) => !result.passed);
  lines.push(`# Visual baseline report: ${report.passed ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push(
    `${report.results.length} frame(s), ${failed.length} failing, tolerance ${report.tolerance}/64 dHash bits.`,
  );
  lines.push("");
  lines.push("| Frame | Status | dHash distance | Expected | Actual |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const result of report.results) {
    const expected = result.expected
      ? `${result.expected.width}x${result.expected.height} ${result.expected.perceptualHash}`
      : "none";
    const actual = `${result.actual.width}x${result.actual.height} ${result.actual.perceptualHash}`;
    lines.push(
      `| ${result.name} | ${result.status} | ${result.hashDistance === undefined ? "n/a" : result.hashDistance} | ${expected} | ${actual} |`,
    );
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push("## Failures");
    for (const result of failed) {
      for (const reason of result.reasons) {
        lines.push(`- ${result.name}: ${reason}`);
      }
    }
  }
  if (report.unusedBaselines.length > 0) {
    lines.push("");
    lines.push(`Baselines without a frame this run: ${report.unusedBaselines.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function loadVisualBaselineFile(path: string): Promise<VisualBaselineFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createVisualBaselineFile();
    }
    throw new VisualBaselineError("baseline.ioFailed", `cannot read ${path}: ${(error as Error).message}`, { path });
  }
  return parseVisualBaselineFile(text);
}

/** Writes a baseline file atomically (temp file + rename). */
export async function saveVisualBaselineFile(path: string, file: VisualBaselineFile): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, serializeVisualBaselineFile(file), "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new VisualBaselineError("baseline.ioFailed", `cannot write ${path}: ${(error as Error).message}`, { path });
  }
}

/**
 * Writes the diff-report artifact for a failing check: `report.json`, `report.md`
 * and the PNG of every failing frame under `<dir>/actual/<name>.png`, so a human
 * can look at what changed before deciding to update. Returns the written paths.
 */
export async function writeVisualBaselineArtifacts(
  directory: string,
  report: VisualBaselineReport,
  frames: readonly VisualFrame[],
): Promise<string[]> {
  const written: string[] = [];
  try {
    await mkdir(join(directory, "actual"), { recursive: true });
    const jsonPath = join(directory, "report.json");
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    written.push(jsonPath);
    const mdPath = join(directory, "report.md");
    await writeFile(mdPath, formatVisualBaselineReport(report), "utf8");
    written.push(mdPath);
    const failing = new Set(report.results.filter((result) => !result.passed).map((result) => result.name));
    for (const frame of frames) {
      if (failing.has(frame.name)) {
        const pngPath = join(directory, "actual", `${frame.name}.png`);
        await writeFile(pngPath, frame.bytes);
        written.push(pngPath);
      }
    }
  } catch (error) {
    throw new VisualBaselineError("baseline.ioFailed", `cannot write artifacts to ${directory}: ${(error as Error).message}`, {
      directory,
    });
  }
  return written;
}
