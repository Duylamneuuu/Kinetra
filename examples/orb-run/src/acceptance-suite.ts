import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AcceptanceRunner,
  acceptanceManifestSchema,
  type AcceptanceReport,
  type RuntimeProbe,
} from "@kinetra/verification";

import { OrbRunHeadlessProbe } from "./acceptance-probe.js";

// Node-only (reads the acceptance directory): deliberately NOT re-exported from `index.ts`, which is bundled for the web player.

/** Manifest files are discovered by this suffix, so a new manifest cannot be forgotten by a hand-kept list. */
export const ORB_RUN_MANIFEST_SUFFIX = ".acceptance.json";

/** Where a manifest could not even start: the file, not the game, is the problem. */
export type OrbRunSuiteErrorCode = "unreadable" | "invalid_json" | "invalid_manifest" | "probe_threw" | "no_manifests";

export interface OrbRunSuiteEntry {
  /** File name inside the acceptance directory. */
  readonly file: string;
  /** `suite` of the manifest (the file name without the suffix when the manifest could not be parsed). */
  readonly suite: string;
  readonly passed: boolean;
  /** Steps the manifest declares (0 when it could not be parsed). */
  readonly steps: number;
  /** Steps the runner reports as passed. */
  readonly passedSteps: number;
  /** First failed step when the game (not the file) failed. */
  readonly failure?: { readonly index: number; readonly type: string; readonly message: string };
  /** Set when the manifest could not be loaded or the probe threw outside a step. */
  readonly error?: { readonly code: OrbRunSuiteErrorCode; readonly message: string };
}

export interface OrbRunSuiteReport {
  readonly passed: boolean;
  readonly total: number;
  readonly failed: number;
  readonly entries: readonly OrbRunSuiteEntry[];
}

export interface RunOrbRunSuiteOptions {
  /** A fresh probe per manifest, so no state leaks between manifests. Defaults to `OrbRunHeadlessProbe`. */
  readonly probeFactory?: () => RuntimeProbe;
}

/** `examples/orb-run/acceptance/` as the package ships it (resolves from both `src` and `dist/src`). */
export function orbRunAcceptanceDirectory(): string {
  return fileURLToPath(new URL("../../acceptance/", import.meta.url));
}

function failureOf(report: AcceptanceReport): OrbRunSuiteEntry["failure"] {
  const step = report.steps.find((candidate) => !candidate.passed);
  if (step) return { index: step.index, type: step.type, message: step.message ?? "" };
  return report.passed ? undefined : { index: -1, type: "suite", message: report.failureReason ?? "the run failed" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run every `*.acceptance.json` directly inside `directory` (sorted by file name, non-recursive: `replays/`
 * holds recordings, not manifests) on the engine `AcceptanceRunner`, one fresh probe each. Never throws for a bad
 * manifest: a file that is unreadable, not JSON, or not an `AcceptanceManifest` becomes a failed entry with a
 * machine-readable `error.code`. An empty directory fails (`no_manifests`) instead of passing vacuously.
 */
export async function runOrbRunAcceptanceSuite(
  directory: string = orbRunAcceptanceDirectory(),
  options: RunOrbRunSuiteOptions = {},
): Promise<OrbRunSuiteReport> {
  const probeFactory = options.probeFactory ?? (() => new OrbRunHeadlessProbe());
  let files: string[];
  try {
    files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(ORB_RUN_MANIFEST_SUFFIX))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return summarize([
      {
        file: directory,
        suite: directory,
        passed: false,
        steps: 0,
        passedSteps: 0,
        error: { code: "unreadable", message: errorMessage(error) },
      },
    ]);
  }
  if (files.length === 0) {
    return summarize([
      {
        file: directory,
        suite: directory,
        passed: false,
        steps: 0,
        passedSteps: 0,
        error: { code: "no_manifests", message: `no *${ORB_RUN_MANIFEST_SUFFIX} file in ${directory}` },
      },
    ]);
  }

  const entries: OrbRunSuiteEntry[] = [];
  for (const file of files) {
    entries.push(await runOne(directory, file, probeFactory));
  }
  return summarize(entries);
}

async function runOne(directory: string, file: string, probeFactory: () => RuntimeProbe): Promise<OrbRunSuiteEntry> {
  const fallbackSuite = file.slice(0, -ORB_RUN_MANIFEST_SUFFIX.length);
  const broken = (code: OrbRunSuiteErrorCode, message: string, suite = fallbackSuite, steps = 0): OrbRunSuiteEntry => ({
    file,
    suite,
    passed: false,
    steps,
    passedSteps: 0,
    error: { code, message },
  });

  let text: string;
  try {
    text = await readFile(join(directory, file), "utf8");
  } catch (error) {
    return broken("unreadable", errorMessage(error));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return broken("invalid_json", errorMessage(error));
  }
  const parsed = acceptanceManifestSchema.safeParse(json);
  if (!parsed.success) return broken("invalid_manifest", parsed.error.message);
  const manifest = parsed.data;

  let report: AcceptanceReport;
  try {
    report = await new AcceptanceRunner(probeFactory()).run(manifest);
  } catch (error) {
    return broken("probe_threw", errorMessage(error), manifest.suite, manifest.steps.length);
  }
  const failure = failureOf(report);
  return {
    file,
    suite: manifest.suite,
    passed: report.passed,
    steps: manifest.steps.length,
    passedSteps: report.steps.filter((step) => step.passed).length,
    ...(failure ? { failure } : {}),
  };
}

function summarize(entries: readonly OrbRunSuiteEntry[]): OrbRunSuiteReport {
  const failed = entries.filter((entry) => !entry.passed).length;
  return { passed: failed === 0, total: entries.length, failed, entries };
}

/** One line per manifest, then a verdict. Pure, so a test can pin it. */
export function formatOrbRunSuiteReport(report: OrbRunSuiteReport): string {
  const lines = report.entries.map((entry) => {
    const head = `${entry.passed ? "PASS" : "FAIL"} ${entry.file} (${entry.passedSteps}/${entry.steps} steps)`;
    if (entry.error) return `${head}: ${entry.error.code}: ${entry.error.message}`;
    if (entry.failure) return `${head}: step ${entry.failure.index} (${entry.failure.type}): ${entry.failure.message}`;
    return head;
  });
  lines.push(
    report.passed
      ? `orb-run acceptance: ${report.total} manifests passed`
      : `orb-run acceptance: ${report.failed} of ${report.total} failed`,
  );
  return lines.join("\n");
}
