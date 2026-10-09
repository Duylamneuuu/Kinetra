import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  VisualBaselineError,
  checkVisualBaselines,
  formatVisualBaselineReport,
  loadVisualBaselineFile,
  saveVisualBaselineFile,
  updateVisualBaselines,
  writeVisualBaselineArtifacts,
  type VisualFrame,
} from "./visual-baseline.js";
import { VisualError } from "./visual.js";

export const VISUAL_BASELINE_USAGE = [
  "usage:",
  "  visual-baseline check  <baselines.json> <frames-dir> [--report-dir <dir>] [--tolerance <0..64>]",
  "  visual-baseline update <baselines.json> <frames-dir> --confirm [--only <name,name>]",
  "",
  "<frames-dir> holds PNG files; each file's name without .png is the frame name.",
  "`check` never writes baselines (exit 1 on any failing frame). `update` is the only",
  "command that changes baselines and refuses to run when CI is set.",
].join("\n");

export interface VisualBaselineCliIo {
  env?: Readonly<Record<string, string | undefined>> | undefined;
  stdout?: ((text: string) => void) | undefined;
  stderr?: ((text: string) => void) | undefined;
}

interface ParsedArguments {
  command: "check" | "update";
  baselinePath: string;
  framesDirectory: string;
  reportDirectory?: string;
  tolerance?: number;
  confirm: boolean;
  only?: string[];
}

class UsageError extends Error {}

function parseArguments(args: readonly string[]): ParsedArguments {
  const [command, ...rest] = args;
  if (command !== "check" && command !== "update") {
    throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
  const positional: string[] = [];
  const parsed: ParsedArguments = { command, baselinePath: "", framesDirectory: "", confirm: false };
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    const valueOf = (): string => {
      const value = rest[++index];
      if (value === undefined) {
        throw new UsageError(`${argument} needs a value`);
      }
      return value;
    };
    if (argument === "--confirm") {
      parsed.confirm = true;
    } else if (argument === "--report-dir") {
      parsed.reportDirectory = valueOf();
    } else if (argument === "--tolerance") {
      const text = valueOf();
      const value = Number(text);
      if (text.trim() === "" || !Number.isFinite(value)) {
        throw new UsageError(`--tolerance must be a number (got ${JSON.stringify(text)})`);
      }
      parsed.tolerance = value;
    } else if (argument === "--only") {
      const only = valueOf().split(",").filter((name) => name.length > 0);
      if (only.length === 0) {
        throw new UsageError("--only needs at least one frame name");
      }
      parsed.only = only;
    } else if (argument.startsWith("--")) {
      throw new UsageError(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 2) {
    throw new UsageError("expected <baselines.json> and <frames-dir>");
  }
  parsed.baselinePath = positional[0]!;
  parsed.framesDirectory = positional[1]!;
  return parsed;
}

async function readFrames(directory: string): Promise<VisualFrame[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => entry.name)
    .sort();
  const frames: VisualFrame[] = [];
  for (const file of names) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, file));
    } catch (error) {
      // A symlink to a directory is not a frame.
      if ((error as NodeJS.ErrnoException).code === "EISDIR") {
        continue;
      }
      throw error;
    }
    frames.push({ name: file.slice(0, -4), bytes: new Uint8Array(bytes) });
  }
  return frames;
}

/** An empty frames directory (wrong path, capture step skipped) must never read as "no regressions". */
function assertHasFrames(frames: readonly VisualFrame[], directory: string): void {
  if (frames.length === 0) {
    throw new VisualBaselineError("baseline.noFrames", `no .png frames found in ${directory}`, { directory });
  }
}

/**
 * Command-line driver for visual baselines. Returns the process exit code:
 * 0 success, 1 baseline check failed, 2 usage/IO/validation error.
 */
export async function runVisualBaselineCli(args: readonly string[], io: VisualBaselineCliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n${VISUAL_BASELINE_USAGE}\n`);
      return 2;
    }
    throw error;
  }
  try {
    const frames = await readFrames(parsed.framesDirectory);
    const baseline = await loadVisualBaselineFile(parsed.baselinePath);
    if (parsed.command === "update") {
      const result = updateVisualBaselines(baseline, frames, {
        confirm: parsed.confirm,
        env: io.env ?? process.env,
        only: parsed.only,
      });
      assertHasFrames(frames, parsed.framesDirectory);
      await saveVisualBaselineFile(parsed.baselinePath, result.file);
      stdout(
        `baselines updated: ${result.added.length} added, ${result.updated.length} updated, ${result.unchanged.length} unchanged\n`,
      );
      return 0;
    }
    const report = checkVisualBaselines(baseline, frames, {
      maxPerceptualHashDistance: parsed.tolerance,
    });
    assertHasFrames(frames, parsed.framesDirectory);
    stdout(formatVisualBaselineReport(report));
    if (!report.passed && parsed.reportDirectory !== undefined) {
      const written = await writeVisualBaselineArtifacts(parsed.reportDirectory, report, frames);
      stdout(`diff artifacts: ${written.length} file(s) in ${parsed.reportDirectory}\n`);
    }
    return report.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof VisualBaselineError || error instanceof VisualError) {
      stderr(`${error.message}\n`);
      return 2;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      stderr(`${(error as Error).message}\n`);
      return 2;
    }
    throw error;
  }
}
