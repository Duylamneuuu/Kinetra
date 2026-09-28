import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export interface TimingPercentiles {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RuntimeRendererMetrics {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
}

export interface RuntimeSceneMetrics {
  objectCount: number;
  visibleObjectCount: number;
  modelInstanceCount: number;
  skinnedMeshCount: number;
  activeAnimationMixerCount: number;
}

export interface RuntimePhysicsMetrics {
  bodyCount: number;
  colliderCount: number;
}

export interface RuntimePerformanceEvidence {
  sampleCount: number;
  warmupSamples: number;
  executionMode: "stepped" | "continuous";
  frame: TimingPercentiles;
  simulation: TimingPercentiles;
  render: TimingPercentiles;
  renderer: RuntimeRendererMetrics;
  scene: RuntimeSceneMetrics;
  physics?: RuntimePhysicsMetrics;
}

export type PerformanceBudgetThreshold =
  | number
  | {
      max?: number;
      min?: number;
    };

export interface PerformanceBudgetDefinition {
  profile?: string;
  budgets?: Record<string, PerformanceBudgetThreshold>;
  windows?: Record<string, PerformanceBudgetThreshold>;
  linux?: Record<string, PerformanceBudgetThreshold>;
  [key: string]: unknown;
}

export interface PerformanceBudgetViolation {
  metric: string;
  limit: number;
  actual: number;
  comparison: "max" | "min";
}

export interface PerformanceBudgetEvaluation {
  passed: boolean;
  violations: PerformanceBudgetViolation[];
  profile?: string;
  platform: string;
}

export interface PerformanceReport {
  hostInfo?: Record<string, unknown>;
  runtimeCommit?: string;
  scene?: string;
  suite?: string;
  budget?: unknown;
  measuredEvidence?: RuntimePerformanceEvidence;
  violations: PerformanceBudgetViolation[];
  passed: boolean;
}

/**
 * Deterministic percentile calculation using linear rank interpolation.
 * Invariant: p50Ms <= p95Ms <= p99Ms <= maxMs
 */
export function calculatePercentiles(samples: number[]): TimingPercentiles {
  if (samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);

  const getPercentile = (p: number): number => {
    if (sorted.length === 1) {
      return sorted[0]!;
    }
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
  };

  return {
    p50Ms: Number(getPercentile(50).toFixed(3)),
    p95Ms: Number(getPercentile(95).toFixed(3)),
    p99Ms: Number(getPercentile(99).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(3)),
  };
}

export function getPerformanceMetricValue(
  evidence: RuntimePerformanceEvidence,
  path: string,
): number | undefined {
  const parts = path.split(".");
  let current: unknown = evidence;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

export function resolveBudgetForPlatform(
  budgetSpec: unknown,
  platform: string = process.platform,
): { profile?: string; thresholds: Record<string, { max?: number; min?: number }> } {
  if (budgetSpec == null || typeof budgetSpec !== "object") {
    return { thresholds: {} };
  }

  const raw = budgetSpec as Record<string, unknown>;
  const inner =
    raw.budget && typeof raw.budget === "object"
      ? (raw.budget as Record<string, unknown>)
      : raw;

  const baseMap =
    inner.budgets && typeof inner.budgets === "object"
      ? (inner.budgets as Record<string, unknown>)
      : raw.budgets && typeof raw.budgets === "object"
        ? (raw.budgets as Record<string, unknown>)
        : inner;

  const profile =
    typeof raw.profile === "string"
      ? raw.profile
      : typeof inner.profile === "string"
        ? inner.profile
        : undefined;

  const thresholds: Record<string, { max?: number; min?: number }> = {};

  const normalizeThreshold = (val: unknown): { max?: number; min?: number } | undefined => {
    if (typeof val === "number" && Number.isFinite(val)) {
      return { max: val };
    }
    if (val && typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const max = typeof obj.max === "number" && Number.isFinite(obj.max) ? obj.max : undefined;
      const min = typeof obj.min === "number" && Number.isFinite(obj.min) ? obj.min : undefined;
      if (max !== undefined || min !== undefined) {
        return { ...(max !== undefined ? { max } : {}), ...(min !== undefined ? { min } : {}) };
      }
    }
    return undefined;
  };

  for (const [key, value] of Object.entries(baseMap)) {
    if (
      key === "type" ||
      key === "profile" ||
      key === "windows" ||
      key === "linux" ||
      key === "budgets" ||
      key === "budget"
    ) {
      continue;
    }
    const norm = normalizeThreshold(value);
    if (norm) {
      thresholds[key] = norm;
    }
  }

  // Platform overrides
  const windowsOverrides = raw.windows ?? inner.windows;
  const linuxOverrides = raw.linux ?? inner.linux;

  const platformOverrides =
    platform === "win32" && windowsOverrides && typeof windowsOverrides === "object"
      ? (windowsOverrides as Record<string, unknown>)
      : platform === "linux" && linuxOverrides && typeof linuxOverrides === "object"
        ? (linuxOverrides as Record<string, unknown>)
        : undefined;

  if (platformOverrides) {
    for (const [key, value] of Object.entries(platformOverrides)) {
      const norm = normalizeThreshold(value);
      if (norm) {
        thresholds[key] = {
          ...thresholds[key],
          ...norm,
        };
      }
    }
  }

  return { ...(profile !== undefined ? { profile } : {}), thresholds };
}

export function evaluatePerformanceBudget(
  evidence: RuntimePerformanceEvidence,
  budgetSpec: unknown,
  options: { platform?: string } = {},
): PerformanceBudgetEvaluation {
  const platform = options.platform ?? process.platform;
  const { profile, thresholds } = resolveBudgetForPlatform(budgetSpec, platform);
  const violations: PerformanceBudgetViolation[] = [];

  for (const [metric, threshold] of Object.entries(thresholds)) {
    const actual = getPerformanceMetricValue(evidence, metric);
    if (actual === undefined) {
      violations.push({
        metric,
        limit: threshold.max ?? threshold.min ?? 0,
        actual: Number.NaN,
        comparison: threshold.max !== undefined ? "max" : "min",
      });
      continue;
    }

    if (threshold.max !== undefined && actual > threshold.max) {
      violations.push({
        metric,
        limit: threshold.max,
        actual,
        comparison: "max",
      });
    }

    if (threshold.min !== undefined && actual < threshold.min) {
      violations.push({
        metric,
        limit: threshold.min,
        actual,
        comparison: "min",
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    ...(profile ? { profile } : {}),
    platform,
  };
}

export async function writePerformanceReport(
  filePath: string,
  report: PerformanceReport,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
}
