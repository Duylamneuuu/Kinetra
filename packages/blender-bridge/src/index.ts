import { spawn } from "node:child_process";

export interface BlenderExportOptions {
  blenderExecutable: string;
  sourceBlend: string;
  outputGlb: string;
  pythonScript: string;
}

export interface ProcessRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Signal that terminated the process, when it did not exit normally. */
  signal?: string | null;
}

export interface ProcessRunner {
  run(executable: string, args: string[]): Promise<ProcessRunResult>;
}

export type BlenderBridgeErrorCode =
  | "blender.invalidOption"
  | "blender.spawnFailed"
  | "blender.exportFailed"
  | "blender.outputMissing";

/** Structured error raised by the Blender bridge boundary. */
export class BlenderBridgeError extends Error {
  readonly code: BlenderBridgeErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: BlenderBridgeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BlenderBridgeError";
    this.code = code;
    this.details = details;
  }
}

/** Maximum characters of process output kept per stream (the tail is kept). */
export const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;
/** Maximum characters of stderr quoted in an export-failure message. */
export const MAX_ERROR_STDERR_CHARS = 4_000;

function appendBounded(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export class NodeProcessRunner implements ProcessRunner {
  readonly #maxOutputChars: number;

  constructor(options: { maxOutputChars?: number } = {}) {
    this.#maxOutputChars = options.maxOutputChars ?? MAX_CAPTURED_OUTPUT_CHARS;
  }

  run(executable: string, args: string[]): Promise<ProcessRunResult> {
    const limit = this.#maxOutputChars;
    return new Promise((resolve, reject) => {
      let settled = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = appendBounded(stdout, chunk, limit);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk, limit);
      });
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      // "close" (not "exit") fires after stdio streams are drained, so the
      // captured output is complete.
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ code: code ?? -1, stdout, stderr, signal: signal ?? null });
      });
    });
  }
}

function requirePathOption(name: keyof BlenderExportOptions, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BlenderBridgeError(
      "blender.invalidOption",
      `Blender export option "${name}" must be a non-empty string`,
      { option: name, received: value === null ? "null" : typeof value },
    );
  }
  if (value.includes("\0")) {
    throw new BlenderBridgeError(
      "blender.invalidOption",
      `Blender export option "${name}" must not contain NUL characters`,
      { option: name },
    );
  }
  return value;
}

/**
 * A relative path that begins with "-" would be parsed as a flag by Blender's
 * or the export script's argument parser; "./" keeps it pointing at the same file.
 */
function protectLeadingDash(path: string): string {
  return path.startsWith("-") ? `./${path}` : path;
}

export function blenderHeadlessArgs(input: BlenderExportOptions): string[] {
  const sourceBlend = requirePathOption("sourceBlend", input.sourceBlend);
  const pythonScript = requirePathOption("pythonScript", input.pythonScript);
  const outputGlb = requirePathOption("outputGlb", input.outputGlb);
  return [
    "--background",
    protectLeadingDash(sourceBlend),
    "--python",
    protectLeadingDash(pythonScript),
    "--",
    "--output",
    protectLeadingDash(outputGlb),
  ];
}

export async function runBlenderExport(
  input: BlenderExportOptions,
  runner: ProcessRunner = new NodeProcessRunner(),
): Promise<void> {
  const executable = requirePathOption("blenderExecutable", input.blenderExecutable);
  const args = blenderHeadlessArgs(input);
  let result: ProcessRunResult;
  try {
    result = await runner.run(executable, args);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new BlenderBridgeError(
      "blender.spawnFailed",
      `Failed to start Blender "${executable}": ${cause}`,
      { executable, cause },
    );
  }
  if (result.code !== 0) {
    const trimmed = result.stderr.trim();
    const stderrTail =
      trimmed.length > MAX_ERROR_STDERR_CHARS ? `…${trimmed.slice(trimmed.length - MAX_ERROR_STDERR_CHARS)}` : trimmed;
    const signalText = result.signal ? ` (signal ${result.signal})` : "";
    throw new BlenderBridgeError(
      "blender.exportFailed",
      `Blender export failed with code ${result.code}${signalText}: ${stderrTail}`,
      { executable, code: result.code, signal: result.signal ?? null, stderrTail },
    );
  }
}

export * from "./importer.js";
