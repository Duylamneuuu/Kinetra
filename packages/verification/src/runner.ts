import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AcceptanceManifest,
  AcceptanceReport,
  AcceptanceStep,
  MissingPathDiagnostic,
  RuntimeLog,
  RuntimeProbe,
  VisualErrorInfo,
  StepResult,
} from "./types.js";
import {
  calculateVisualEvidence,
  compareVisualFrames,
  decodePng,
  detectBlankFrame,
  VisualError,
  type DecodedImage,
  type VisualComparison,
  type VisualFrameEvidence,
} from "./visual.js";
import type {
  VisualCritiqueProvider,
  VisualCritiqueReport,
} from "./critique.js";
import {
  evaluatePerformanceBudget,
  type RuntimePerformanceEvidence,
  type PerformanceBudgetViolation,
} from "./performance.js";

const MAX_DIAGNOSTIC_KEYS = 12;

class MissingPathError extends Error {
  readonly diagnostic: MissingPathDiagnostic;

  constructor(message: string, diagnostic: MissingPathDiagnostic) {
    super(message);
    this.name = "MissingPathError";
    this.diagnostic = diagnostic;
  }
}

function getPath(root: unknown, path: string): unknown {
  if (path.trim() === "") return root;
  let value: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Cannot read "${path}": "${segment}" traverses non-object data`,
      );
    }
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) {
      const available = Object.keys(record).sort();
      const diagnostic: MissingPathDiagnostic = {
        kind: "missing_path",
        path,
        missingSegment: segment,
        availableKeys: available.slice(0, MAX_DIAGNOSTIC_KEYS),
      };
      throw new MissingPathError(
        `Missing "${segment}" while reading "${path}". Available keys: ${formatAvailableKeys(available)}`,
        diagnostic,
      );
    }
    value = record[segment];
  }
  return value;
}

function readAssertedPath(root: unknown, path: string, expected: unknown): unknown {
  try {
    return getPath(root, path);
  } catch (error) {
    if (error instanceof MissingPathError) {
      throw new StepAssertionError(error.message, expected, undefined, error.diagnostic);
    }
    throw error;
  }
}

function formatAvailableKeys(keys: string[]): string {
  if (keys.length === 0) {
    return "(none)";
  }
  const shown = keys.slice(0, 12);
  const extra = keys.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function severity(level: RuntimeLog["level"]): number {
  return { debug: 0, info: 1, warning: 2, error: 3 }[level];
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isValidPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

export class StepAssertionError extends Error {
  constructor(
    message: string,
    public readonly expected?: unknown,
    public readonly actual?: unknown,
    public readonly diagnostics?: MissingPathDiagnostic,
  ) {
    super(message);
    this.name = "StepAssertionError";
  }
}

export interface AcceptanceRunnerOptions {
  artifactDir?: string | undefined;
  critiqueProvider?: VisualCritiqueProvider | undefined;
}

export interface StepExecutionContext {
  probe: RuntimeProbe;
  seed: number;
  capturedFrames: Map<
    string,
    { bytes: Uint8Array; evidence: VisualFrameEvidence; decoded: DecodedImage }
  >;
  options: AcceptanceRunnerOptions;
  lastPerformanceEvidence?: RuntimePerformanceEvidence | undefined;
}

export interface StepExecutionOutput {
  visualEvidence?: VisualFrameEvidence | undefined;
  visualComparison?: VisualComparison | undefined;
  critiqueReport?: VisualCritiqueReport | undefined;
  performanceEvidence?: RuntimePerformanceEvidence | undefined;
  performanceViolations?: PerformanceBudgetViolation[] | undefined;
  message?: string | undefined;
}

/**
 * A step whose probe method is optional must not pass when the probe lacks it:
 * that would report evidence the run never gathered (issue #122).
 */
function unsupportedStep(stepType: AcceptanceStep["type"], method: string): never {
  throw new StepAssertionError(
    `UNSUPPORTED_STEP: runtime probe does not implement ${method}() required by step "${stepType}"`,
    `probe.${method}()`,
    undefined,
  );
}

async function executeStep(
  context: StepExecutionContext,
  step: AcceptanceStep,
): Promise<StepExecutionOutput | void> {
  const { probe, seed, capturedFrames, options } = context;

  switch (step.type) {
    case "runtime.start":
      if (step.assets && Object.keys(step.assets).length > 0) {
        if (typeof probe.registerAsset !== "function") unsupportedStep(step.type, "registerAsset");
        for (const [assetId, dataBase64] of Object.entries(step.assets)) {
          await probe.registerAsset(assetId, dataBase64);
        }
      }
      await probe.start(step.sceneId, seed);
      return;
    case "asset.register":
      if (typeof probe.registerAsset !== "function") unsupportedStep(step.type, "registerAsset");
      await probe.registerAsset(step.assetId, step.dataBase64);
      return;
    case "runtime.stop":
      await probe.stop();
      return;
    case "runtime.pause":
      if (typeof probe.pause !== "function") unsupportedStep(step.type, "pause");
      await probe.pause();
      return;
    case "runtime.resume":
      if (typeof probe.resume !== "function") unsupportedStep(step.type, "resume");
      await probe.resume();
      return;
    case "runtime.step":
      if (typeof probe.step === "function") {
        await probe.step(step.steps, step.deltaSeconds);
      } else {
        await probe.wait((step.steps ?? 1) * (step.deltaSeconds ?? 1 / 60) * 1000);
      }
      return;
    case "animation.play":
      if (typeof probe.playAnimation !== "function") unsupportedStep(step.type, "playAnimation");
      await probe.playAnimation(
        step.entityId,
        step.clip,
        step.loop !== undefined ? { loop: step.loop } : undefined,
      );
      return;
    case "animation.stop":
      if (typeof probe.stopAnimation !== "function") unsupportedStep(step.type, "stopAnimation");
      await probe.stopAnimation(step.entityId);
      return;
    case "audio.play":
      if (typeof probe.playAudio !== "function") unsupportedStep(step.type, "playAudio");
      await probe.playAudio({
        assetId: step.assetId,
        ...(step.bus !== undefined ? { bus: step.bus } : {}),
        ...(step.loop !== undefined ? { loop: step.loop } : {}),
        ...(step.gain !== undefined ? { gain: step.gain } : {}),
        ...(step.entityId !== undefined ? { entityId: step.entityId } : {}),
      });
      return;
    case "audio.stop":
      if (typeof probe.stopAudio !== "function") unsupportedStep(step.type, "stopAudio");
      await probe.stopAudio({
        ...(step.playbackId !== undefined ? { playbackId: step.playbackId } : {}),
        ...(step.entityId !== undefined ? { entityId: step.entityId } : {}),
      });
      return;
    case "audio.setBusGain":
      if (typeof probe.setAudioBusGain !== "function") unsupportedStep(step.type, "setAudioBusGain");
      await probe.setAudioBusGain(step.busId, step.gain);
      return;
    case "audio.setBusMuted":
      if (typeof probe.setAudioBusMuted !== "function") unsupportedStep(step.type, "setAudioBusMuted");
      await probe.setAudioBusMuted(step.busId, step.muted);
      return;
    case "navigation.bake":
      if (typeof probe.bakeNavigation !== "function") unsupportedStep(step.type, "bakeNavigation");
      await probe.bakeNavigation({
        ...(step.positions ? { positions: step.positions } : {}),
        ...(step.indices ? { indices: step.indices } : {}),
        ...(step.config ? { config: step.config } : {}),
      });
      return;
    case "navigation.load":
      if (typeof probe.loadNavigation !== "function") unsupportedStep(step.type, "loadNavigation");
      await probe.loadNavigation({ dataBase64: step.dataBase64 });
      return;
    case "navigation.closestPoint":
      if (typeof probe.closestPointNavigation !== "function") unsupportedStep(step.type, "closestPointNavigation");
      await probe.closestPointNavigation({
        position: step.position,
        ...(step.halfExtents ? { halfExtents: step.halfExtents } : {}),
      });
      return;
    case "navigation.computePath":
      if (typeof probe.computePathNavigation !== "function") unsupportedStep(step.type, "computePathNavigation");
      await probe.computePathNavigation({
        start: step.start,
        end: step.end,
        ...(step.halfExtents ? { halfExtents: step.halfExtents } : {}),
      });
      return;
    case "save.capture": {
      if (typeof probe.captureSave !== "function") unsupportedStep(step.type, "captureSave");
      const result = await probe.captureSave(step.slotId);
      if (!result.success) {
        throw new StepAssertionError(`Failed to capture save: ${result.error ?? "unknown error"}`);
      }
      return;
    }
    case "save.load": {
      if (typeof probe.loadSave !== "function") unsupportedStep(step.type, "loadSave");
      const result = await probe.loadSave({
        ...(step.slotId ? { slotId: step.slotId } : {}),
        ...(step.envelope ? { envelope: step.envelope } : {}),
      });
      if (!result.success) {
        throw new StepAssertionError(`Failed to load save: ${result.error ?? "unknown error"}`);
      }
      return;
    }
    case "input":
      await probe.input({
        action: step.action,
        phase: step.phase,
        ...(step.value !== undefined ? { value: step.value } : {}),
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      });
      return;
    case "wait":
      await probe.wait(step.milliseconds);
      return;
    case "assert.equal": {
      const actual = readAssertedPath(await probe.snapshot(), step.path, step.expected);
      if (!stableEqual(actual, step.expected)) {
        throw new StepAssertionError(
          `Expected ${step.path} = ${JSON.stringify(step.expected)}, got ${JSON.stringify(actual)}`,
          step.expected,
          actual,
        );
      }
      return;
    }
    case "assert.near": {
      const actual = readAssertedPath(await probe.snapshot(), step.path, step.expected);
      if (typeof actual !== "number") {
        throw new StepAssertionError(
          `Expected numeric value at ${step.path}`,
          step.expected,
          actual,
        );
      }
      if (Math.abs(actual - step.expected) > step.tolerance) {
        throw new StepAssertionError(
          `Expected ${step.path} near ${step.expected} ± ${step.tolerance}, got ${actual}`,
          step.expected,
          actual,
        );
      }
      return;
    }
    case "assert.logAbsent": {
      const minimum = severity(step.minimumLevel);
      const offending = (await probe.logs()).find(
        (log) =>
          severity(log.level) >= minimum &&
          (step.messageIncludes === undefined || log.message.includes(step.messageIncludes)),
      );
      if (offending) {
        throw new StepAssertionError(
          `Unexpected ${offending.level} log: ${offending.message}`,
          `no logs with level >= ${step.minimumLevel}${step.messageIncludes ? ` containing "${step.messageIncludes}"` : ""}`,
          `[${offending.level}] ${offending.message}`,
        );
      }
      return;
    }
    case "assert.metricMax": {
      const value = (await probe.metrics())[step.metric];
      if (value === undefined)
        throw new StepAssertionError(`Metric "${step.metric}" is unavailable`, step.max, undefined);
      if (value > step.max)
        throw new StepAssertionError(
          `Metric "${step.metric}" = ${value} exceeds max ${step.max}`,
          step.max,
          value,
        );
      return;
    }
    case "assert.metricMin": {
      const value = (await probe.metrics())[step.metric];
      if (value === undefined)
        throw new StepAssertionError(`Metric "${step.metric}" is unavailable`, step.min, undefined);
      if (value < step.min)
        throw new StepAssertionError(
          `Metric "${step.metric}" = ${value} is below min ${step.min}`,
          step.min,
          value,
        );
      return;
    }
    case "assert.screenshotSha256": {
      const actual = createHash("sha256").update(await probe.captureFrame()).digest("hex");
      if (actual !== step.sha256) {
        throw new StepAssertionError(
          `Screenshot hash mismatch: expected ${step.sha256}, got ${actual}`,
          step.sha256,
          actual,
        );
      }
      return;
    }
    case "assert.screenshotValidPng": {
      const bytes = await probe.captureFrame();
      const minBytes = step.minBytes ?? 1_000;
      if (bytes.length < minBytes) {
        throw new StepAssertionError(
          `Screenshot too small: expected at least ${minBytes} bytes, got ${bytes.length}`,
          minBytes,
          bytes.length,
        );
      }
      if (!isValidPng(bytes)) {
        throw new StepAssertionError(
          "Screenshot is not a valid PNG (missing PNG magic header)",
          "valid PNG magic header",
          bytes.length >= 8
            ? Array.from(bytes.slice(0, 8))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(" ")
            : "truncated",
        );
      }
      return;
    }
    case "capture.frame": {
      const bytes = await probe.captureFrame();
      const evidence = calculateVisualEvidence(bytes);
      const decoded = decodePng(bytes);
      capturedFrames.set(step.id, { bytes, evidence, decoded });

      if (step.saveArtifact && options.artifactDir) {
        const sanitized = step.id.replace(/[^a-zA-Z0-9_-]/g, "_");
        await mkdir(options.artifactDir, { recursive: true });
        await writeFile(join(options.artifactDir, `${sanitized}.png`), bytes);
      }

      return {
        visualEvidence: evidence,
        message: `Captured frame "${step.id}" (${evidence.width}x${evidence.height}, hash: ${evidence.perceptualHash})`,
      };
    }
    case "assert.visualNotBlank": {
      let frame = step.captureId ? capturedFrames.get(step.captureId) : undefined;
      if (!frame) {
        if (step.captureId) {
          throw new StepAssertionError(
            `Unknown capture ID "${step.captureId}". Available captures: ${Array.from(capturedFrames.keys()).join(", ") || "(none)"}`,
            "valid capture ID",
            step.captureId,
          );
        }
        const bytes = await probe.captureFrame();
        frame = {
          bytes,
          evidence: calculateVisualEvidence(bytes),
          decoded: decodePng(bytes),
        };
      }

      const result = detectBlankFrame(frame.evidence, {
        ...(step.minOpaqueRatio !== undefined ? { minOpaqueRatio: step.minOpaqueRatio } : {}),
        ...(step.minLuminanceVariance !== undefined
          ? { minLuminanceVariance: step.minLuminanceVariance }
          : {}),
        ...(step.minEntropy !== undefined ? { minEntropy: step.minEntropy } : {}),
      });

      if (result.isBlank) {
        throw new StepAssertionError(
          `Visual blank frame detected: ${result.reason}`,
          "non-blank frame with sufficient variance and entropy",
          {
            meanLuminance: frame.evidence.meanLuminance,
            luminanceVariance: frame.evidence.luminanceVariance,
            entropy: frame.evidence.entropy,
            opaquePixelRatio: frame.evidence.opaquePixelRatio,
            reason: result.reason,
          },
        );
      }

      return { visualEvidence: frame.evidence };
    }
    case "assert.visualSimilarity": {
      const ref = capturedFrames.get(step.referenceCaptureId);
      if (!ref) {
        throw new StepAssertionError(
          `Reference capture ID "${step.referenceCaptureId}" not found. Available captures: ${Array.from(capturedFrames.keys()).join(", ") || "(none)"}`,
          "valid reference capture ID",
          step.referenceCaptureId,
        );
      }

      let actual = step.actualCaptureId ? capturedFrames.get(step.actualCaptureId) : undefined;
      if (!actual) {
        if (step.actualCaptureId) {
          throw new StepAssertionError(
            `Actual capture ID "${step.actualCaptureId}" not found. Available captures: ${Array.from(capturedFrames.keys()).join(", ") || "(none)"}`,
            "valid actual capture ID",
            step.actualCaptureId,
          );
        }
        const bytes = await probe.captureFrame();
        actual = {
          bytes,
          evidence: calculateVisualEvidence(bytes),
          decoded: decodePng(bytes),
        };
      }

      const comparison = compareVisualFrames(ref.bytes, actual.bytes, {
        ...(step.maxChangedPixelRatio !== undefined
          ? { maxChangedPixelRatio: step.maxChangedPixelRatio }
          : {}),
        ...(step.maxPerceptualHashDistance !== undefined
          ? { maxPerceptualHashDistance: step.maxPerceptualHashDistance }
          : {}),
        ...(step.maxMeanAbsoluteDifference !== undefined
          ? { maxMeanAbsoluteDifference: step.maxMeanAbsoluteDifference }
          : {}),
        ...(step.pixelDiffThreshold !== undefined
          ? { pixelDiffThreshold: step.pixelDiffThreshold }
          : {}),
      });

      if (!comparison.similar) {
        throw new StepAssertionError(
          `visual.perceptualMismatch: Frame "${step.actualCaptureId ?? "current"}" differs from reference "${step.referenceCaptureId}" (changedPixels: ${(comparison.changedPixelRatio * 100).toFixed(1)}%, hashDist: ${comparison.perceptualHashDistance}, meanDiff: ${comparison.meanAbsoluteDifference})`,
          {
            maxChangedPixelRatio: step.maxChangedPixelRatio ?? 0.05,
            maxPerceptualHashDistance: step.maxPerceptualHashDistance ?? 8,
            maxMeanAbsoluteDifference: step.maxMeanAbsoluteDifference ?? 0.08,
          },
          {
            changedPixelRatio: comparison.changedPixelRatio,
            perceptualHashDistance: comparison.perceptualHashDistance,
            meanAbsoluteDifference: comparison.meanAbsoluteDifference,
            referenceCaptureId: step.referenceCaptureId,
            actualCaptureId: step.actualCaptureId ?? "current",
          },
        );
      }

      return { visualComparison: comparison };
    }
    case "assert.visualDifference": {
      const ref = capturedFrames.get(step.referenceCaptureId);
      if (!ref) {
        throw new StepAssertionError(
          `Reference capture ID "${step.referenceCaptureId}" not found. Available captures: ${Array.from(capturedFrames.keys()).join(", ") || "(none)"}`,
          "valid reference capture ID",
          step.referenceCaptureId,
        );
      }

      let actual = step.actualCaptureId ? capturedFrames.get(step.actualCaptureId) : undefined;
      if (!actual) {
        if (step.actualCaptureId) {
          throw new StepAssertionError(
            `Actual capture ID "${step.actualCaptureId}" not found. Available captures: ${Array.from(capturedFrames.keys()).join(", ") || "(none)"}`,
            "valid actual capture ID",
            step.actualCaptureId,
          );
        }
        const bytes = await probe.captureFrame();
        actual = {
          bytes,
          evidence: calculateVisualEvidence(bytes),
          decoded: decodePng(bytes),
        };
      }

      const comparison = compareVisualFrames(ref.bytes, actual.bytes);
      const minChangedPixelRatio = step.minChangedPixelRatio ?? 0.05;
      const minPerceptualHashDistance = step.minPerceptualHashDistance ?? 6;

      const hasDifference =
        comparison.changedPixelRatio >= minChangedPixelRatio ||
        comparison.perceptualHashDistance >= minPerceptualHashDistance;

      if (!hasDifference) {
        throw new StepAssertionError(
          `Expected visual difference between "${step.actualCaptureId ?? "current"}" and "${step.referenceCaptureId}", but frames appear perceptually identical (changedPixels: ${(comparison.changedPixelRatio * 100).toFixed(1)}%, hashDist: ${comparison.perceptualHashDistance})`,
          { minChangedPixelRatio, minPerceptualHashDistance },
          {
            changedPixelRatio: comparison.changedPixelRatio,
            perceptualHashDistance: comparison.perceptualHashDistance,
            referenceCaptureId: step.referenceCaptureId,
            actualCaptureId: step.actualCaptureId ?? "current",
          },
        );
      }

      return { visualComparison: comparison };
    }
    case "critique.visual": {
      if (!options.critiqueProvider) {
        if (step.requireProvider) {
          throw new StepAssertionError(
            "visual.providerUnavailable: Visual critique was required by manifest but no VisualCritiqueProvider is configured",
            "configured VisualCritiqueProvider",
            undefined,
          );
        }
        return { message: "Visual critique skipped: no VisualCritiqueProvider configured" };
      }

      let frame = step.captureId ? capturedFrames.get(step.captureId) : undefined;
      if (!frame) {
        if (step.captureId) {
          throw new StepAssertionError(
            `Capture ID "${step.captureId}" not found for visual critique. Available captures: ${Array.from(capturedFrames.keys()).join(", ") || "(none)"}`,
            "valid capture ID",
            step.captureId,
          );
        }
        const bytes = await probe.captureFrame();
        frame = {
          bytes,
          evidence: calculateVisualEvidence(bytes),
          decoded: decodePng(bytes),
        };
      }

      const snapshot = await probe.snapshot().catch(() => undefined);
      const logs = await probe.logs().catch(() => undefined);

      let report: VisualCritiqueReport;
      try {
        report = await options.critiqueProvider.critique({
          captureId: step.captureId ?? "current",
          framePng: frame.bytes,
          evidence: frame.evidence,
          rubric: step.rubric,
          ...(step.expectedVisualFacts ? { expectedVisualFacts: step.expectedVisualFacts } : {}),
          ...(snapshot?.state ? { runtimeState: snapshot.state } : {}),
          ...(logs ? { recentLogs: logs } : {}),
        });
      } catch (err) {
        throw new StepAssertionError(
          `visual.providerError: ${err instanceof Error ? err.message : String(err)}`,
          "successful critique report",
          undefined,
        );
      }

      if (report.verdict === "fail") {
        const errorMsgs =
          report.findings
            .filter((f) => f.severity === "error")
            .map((f) => f.message)
            .join("; ") || "visual critique verdict failed";
        throw new StepAssertionError(
          `visual.critiqueFailed: ${errorMsgs}`,
          { verdict: "pass" },
          report,
        );
      }

      return { critiqueReport: report };
    }

    case "performance.sample": {
      if (typeof probe.samplePerformance !== "function") {
        throw new StepAssertionError(
          "performance.sample: Runtime probe does not support samplePerformance",
          "function",
          undefined,
        );
      }
      const evidence = await probe.samplePerformance({
        ...(step.warmupFrames !== undefined ? { warmupFrames: step.warmupFrames } : {}),
        ...(step.sampleFrames !== undefined ? { sampleFrames: step.sampleFrames } : {}),
        ...(step.fixedDeltaSeconds !== undefined ? { fixedDeltaSeconds: step.fixedDeltaSeconds } : {}),
        ...(step.mode !== undefined ? { mode: step.mode } : {}),
      });
      context.lastPerformanceEvidence = evidence;
      return {
        message: `Sampled ${evidence.sampleCount} frames (${evidence.executionMode}) - frame p95: ${evidence.frame.p95Ms}ms, drawCalls: ${evidence.renderer.drawCalls}, tris: ${evidence.renderer.triangles}`,
        performanceEvidence: evidence,
      };
    }

    case "assert.performanceBudget": {
      let evidence = context.lastPerformanceEvidence;
      if (!evidence) {
        if (typeof probe.samplePerformance === "function") {
          evidence = await probe.samplePerformance();
          context.lastPerformanceEvidence = evidence;
        } else {
          throw new StepAssertionError(
            "assert.performanceBudget: No performance evidence has been sampled and probe cannot sample",
            "RuntimePerformanceEvidence",
            undefined,
          );
        }
      }

      const evaluation = evaluatePerformanceBudget(evidence, step, {
        platform: process.platform,
      });

      if (!evaluation.passed) {
        const violationSummary = evaluation.violations
          .map((v) => `${v.metric} actual ${v.actual} exceeds ${v.comparison} ${v.limit}`)
          .join("; ");
        throw new StepAssertionError(
          `performance.budgetExceeded: ${violationSummary}`,
          step.budget,
          {
            violations: evaluation.violations,
            evidence,
            platform: evaluation.platform,
            sampleCount: evidence.sampleCount,
          },
        );
      }

      return {
        message: `Performance budget passed (${evaluation.profile ?? "default"})`,
        performanceEvidence: evidence,
      };
    }
  }
}

export class AcceptanceRunner {
  constructor(
    private readonly probe: RuntimeProbe,
    private readonly options: AcceptanceRunnerOptions = {},
  ) {}

  async run(manifest: AcceptanceManifest): Promise<AcceptanceReport> {
    if (manifest.schemaVersion !== 1)
      throw new Error("Unsupported acceptance manifest schema");
    const started = new Date();
    const startedPerf = performance.now();
    const steps: StepResult[] = [];
    let runtimeStarted = false;

    const capturedFrames = new Map<
      string,
      { bytes: Uint8Array; evidence: VisualFrameEvidence; decoded: DecodedImage }
    >();
    const context: StepExecutionContext = {
      probe: this.probe,
      seed: manifest.seed,
      capturedFrames,
      options: this.options,
    };

    const visualCaptures: Record<string, VisualFrameEvidence> = {};
    const critiqueReports: VisualCritiqueReport[] = [];
    let lastPerformanceEvidence: RuntimePerformanceEvidence | undefined;
    const allPerformanceViolations: PerformanceBudgetViolation[] = [];

    try {
      for (let index = 0; index < manifest.steps.length; index++) {
        const step = manifest.steps[index]!;
        const before = performance.now();
        try {
          if (step.type === "runtime.start") {
            runtimeStarted = true;
          } else if (step.type === "runtime.stop") {
            runtimeStarted = false;
          }
          const output = await executeStep(context, step);
          if (output?.visualEvidence) {
            if ("id" in step && typeof step.id === "string") {
              visualCaptures[step.id] = output.visualEvidence;
            }
          }
          if (output?.critiqueReport) {
            critiqueReports.push(output.critiqueReport);
          }
          if (output?.performanceEvidence) {
            lastPerformanceEvidence = output.performanceEvidence;
          }
          steps.push({
            index,
            type: step.type,
            passed: true,
            durationMs: performance.now() - before,
            ...(output?.message !== undefined ? { message: output.message } : {}),
            ...(output?.visualEvidence !== undefined
              ? { visualEvidence: output.visualEvidence }
              : {}),
            ...(output?.visualComparison !== undefined
              ? { visualComparison: output.visualComparison }
              : {}),
            ...(output?.critiqueReport !== undefined
              ? { critiqueReport: output.critiqueReport }
              : {}),
            ...(output?.performanceEvidence !== undefined
              ? { performanceEvidence: output.performanceEvidence }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isAssertion = error instanceof StepAssertionError;
          const expected = isAssertion
            ? error.expected
            : ("expected" in step
                ? (step as any).expected
                : undefined);
          const actual = isAssertion ? error.actual : undefined;
          const diagnostics = isAssertion ? error.diagnostics : undefined;
          const visualError: VisualErrorInfo | undefined =
            error instanceof VisualError
              ? { code: error.code, details: error.details }
              : undefined;
          const violations =
            isAssertion && actual && typeof actual === "object" && Array.isArray((actual as any).violations)
              ? ((actual as any).violations as PerformanceBudgetViolation[])
              : undefined;
          if (violations) {
            allPerformanceViolations.push(...violations);
          }
          steps.push({
            index,
            type: step.type,
            passed: false,
            durationMs: performance.now() - before,
            message,
            error: message,
            ...(expected !== undefined ? { expected } : {}),
            ...(actual !== undefined ? { actual } : {}),
            ...(diagnostics !== undefined ? { diagnostics } : {}),
            ...(visualError !== undefined ? { visualError } : {}),
            ...(violations !== undefined ? { performanceViolations: violations } : {}),
          });
          break;
        }
      }
    } finally {
      capturedFrames.clear(); // Free image buffers
      if (runtimeStarted) {
        try {
          await this.probe.stop();
        } catch {
          // Clean teardown on failure
        }
      }
    }

    const finished = new Date();
    const durationMs = performance.now() - startedPerf;
    const failedSteps = steps.filter((step) => !step.passed);
    const failureReason = failedSteps.length > 0 ? failedSteps[0]?.message : undefined;

    return {
      suite: manifest.suite,
      target: manifest.target,
      passed: steps.length === manifest.steps.length && steps.every((step) => step.passed),
      durationMs,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      steps,
      failedSteps,
      ...(failureReason !== undefined ? { failureReason } : {}),
      observations: {
        totalSteps: manifest.steps.length,
        executedSteps: steps.length,
        target: manifest.target,
        platform: process.platform,
        ...(Object.keys(visualCaptures).length > 0 ? { visualCaptures } : {}),
        ...(critiqueReports.length > 0 ? { critiqueReports } : {}),
        ...(lastPerformanceEvidence ? { performance: lastPerformanceEvidence } : {}),
        ...(allPerformanceViolations.length > 0
          ? { performanceViolations: allPerformanceViolations }
          : {}),
      },
    };
  }
}
