import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  canonicalArenaProject,
  createArenaProject,
  arenaAudioAssets,
} from "@kinetra/reference-game";

import {
  acceptanceManifestSchema,
  type AcceptanceManifest,
  type AcceptanceReport,
} from "./types.js";
import { AcceptanceRunner } from "./runner.js";
import { KinetraRuntimeProbe } from "./runtime-probe.js";
import {
  ElectronRuntimeHost,
  realElectronLaunchArgs,
} from "./electron-runtime.js";
import {
  findRepositoryRoot,
  packagedBuildCommand,
  resolvePackagedExecutable,
} from "./packaged-resolver.js";
import {
  writePerformanceReport,
  type RuntimePerformanceEvidence,
  type PerformanceReport,
} from "./performance.js";

export const shippingAcceptancePhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  freshProcess: z.boolean().default(true),
  captureMode: z.enum(["performance", "visual"]).default("performance"),
  persistenceGroup: z.string().optional(),
  manifest: acceptanceManifestSchema,
}).strict();

export type ShippingAcceptancePhase = z.infer<typeof shippingAcceptancePhaseSchema>;

export const shippingAcceptancePlanSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.string().min(1),
  target: z.enum(["packaged", "dev"]).default("packaged"),
  phases: z.array(shippingAcceptancePhaseSchema).min(1),
}).strict();

export type ShippingAcceptancePlan = z.infer<typeof shippingAcceptancePlanSchema>;

export interface ShippingPhaseResult {
  id: string;
  name?: string | undefined;
  passed: boolean;
  processId?: number | string | undefined;
  captureMode: "performance" | "visual";
  acceptanceReport: AcceptanceReport;
}

export interface ShippingAcceptanceReport {
  suite: string;
  planSha256: string;
  planPath?: string | undefined;
  passed: boolean;
  artifact: {
    execPath: string;
    sha256: string;
    platform: string;
    arch: string;
    isPackaged: boolean;
  };
  phases: ShippingPhaseResult[];
  failedPhaseIds: string[];
  failureReason?: string | undefined;
  persistenceEvidence?: Record<string, unknown> | undefined;
  visualEvidence?: Record<string, unknown> | undefined;
  performanceEvidence?: RuntimePerformanceEvidence | undefined;
}

export interface ShippingRunnerOptions {
  plan?: ShippingAcceptancePlan | string | undefined;
  planPath?: string | undefined;
  target?: "packaged" | "dev" | undefined;
  runtimeExecutable?: string | undefined;
  saveBaseDir?: string | undefined;
  outputDir?: string | undefined;
  timeoutMs?: number | undefined;
  onPhaseStart?: (phase: ShippingAcceptancePhase, index: number) => void;
  onPhaseEnd?: (result: ShippingPhaseResult, index: number) => void;
}

export function calculateSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function calculateFileSha256(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return calculateSha256(bytes);
}

export function calculatePlanSha256(plan: ShippingAcceptancePlan | string): string {
  const content = typeof plan === "string" ? plan : JSON.stringify(plan);
  return calculateSha256(content);
}

export async function loadShippingPlan(planPath: string): Promise<{
  plan: ShippingAcceptancePlan;
  rawJson: string;
  planSha256: string;
}> {
  const rawJson = await readFile(planPath, "utf8");
  const parsed = JSON.parse(rawJson);
  const validated = shippingAcceptancePlanSchema.parse(parsed);
  const planSha256 = calculateSha256(rawJson);
  return { plan: validated, rawJson, planSha256 };
}

export function defaultCanonicalPlanPath(): string {
  const root = findRepositoryRoot();
  return resolve(root, "examples/reference-game/acceptance/shipping.acceptance.json");
}

export class ShippingAcceptanceRunner {
  readonly #options: ShippingRunnerOptions;

  constructor(options: ShippingRunnerOptions = {}) {
    this.#options = options;
  }

  async run(overridePlan?: ShippingAcceptancePlan): Promise<ShippingAcceptanceReport> {
    const planPath = this.#options.planPath ?? (typeof this.#options.plan === "string" ? this.#options.plan : undefined) ?? defaultCanonicalPlanPath();

    let plan: ShippingAcceptancePlan;
    let planSha256: string;

    if (overridePlan) {
      plan = shippingAcceptancePlanSchema.parse(overridePlan);
      planSha256 = calculatePlanSha256(plan);
    } else if (typeof this.#options.plan === "object") {
      plan = shippingAcceptancePlanSchema.parse(this.#options.plan);
      planSha256 = calculatePlanSha256(plan);
    } else if (existsSync(planPath)) {
      const loaded = await loadShippingPlan(planPath);
      plan = loaded.plan;
      planSha256 = loaded.planSha256;
    } else {
      throw new Error(`Shipping acceptance plan not found at "${planPath}"`);
    }

    const targetMode = this.#options.target ?? plan.target;
    let execPath: string;
    let execSha256: string;

    if (targetMode === "packaged") {
      let resolvedPath = this.#options.runtimeExecutable ?? process.env.KINETRA_RUNTIME_EXECUTABLE;
      if (!resolvedPath) {
        try {
          const resolution = resolvePackagedExecutable({ platform: process.platform });
          resolvedPath = resolution.path;
        } catch (err) {
          throw new Error(
            `Packaged executable not found: ${err instanceof Error ? err.message : String(err)}. Run "${packagedBuildCommand(process.platform)}" first.`,
          );
        }
      }
      if (!existsSync(resolvedPath)) {
        throw new Error(
          `Packaged executable not found at "${resolvedPath}". Run "${packagedBuildCommand(process.platform)}" first.`,
        );
      }
      execPath = resolvedPath;
      execSha256 = await calculateFileSha256(execPath);
    } else {
      execPath = process.execPath;
      execSha256 = "dev-electron";
    }

    const platform = process.platform;
    const arch = process.arch;

    const baseSaveDir = this.#options.saveBaseDir ?? (await mkdtemp(join(tmpdir(), "kinetra-shipping-saves-")));
    const cleanupSaveDir = !this.#options.saveBaseDir;

    if (this.#options.outputDir) {
      await mkdir(this.#options.outputDir, { recursive: true });
    }

    const phaseResults: ShippingPhaseResult[] = [];
    const failedPhaseIds: string[] = [];
    let failureReason: string | undefined;

    const persistenceEvidence: Record<string, unknown> = {};
    const visualEvidence: Record<string, unknown> = {};
    let performanceEvidence: RuntimePerformanceEvidence | undefined;

    let currentHost: ElectronRuntimeHost | undefined;
    let currentProbe: KinetraRuntimeProbe | undefined;
    let currentCaptureMode: "performance" | "visual" | undefined;
    let currentPersistenceGroup: string | undefined;

    try {
      for (let i = 0; i < plan.phases.length; i++) {
        const phase = plan.phases[i]!;
        this.#options.onPhaseStart?.(phase, i);

        const groupName = phase.persistenceGroup ?? "default";
        const groupSaveDir = join(baseSaveDir, groupName);
        await mkdir(groupSaveDir, { recursive: true });

        const needsFresh = phase.freshProcess ||
          !currentHost ||
          currentCaptureMode !== phase.captureMode ||
          currentPersistenceGroup !== groupName;

        if (needsFresh) {
          if (currentHost) {
            await currentHost.close();
            currentHost = undefined;
            currentProbe = undefined;
          }

          currentHost = new ElectronRuntimeHost({
            electronArgs: realElectronLaunchArgs(),
            requestTimeoutMs: this.#options.timeoutMs ?? 30_000,
            saveDir: groupSaveDir,
            captureMode: phase.captureMode,
            ...(targetMode === "packaged" ? { runtimeExecutable: execPath } : {}),
          });

          currentCaptureMode = phase.captureMode;
          currentPersistenceGroup = groupName;

          currentProbe = new KinetraRuntimeProbe({
            host: currentHost,
            project: () => createArenaProject(),
            initialRevision: 0,
            assets: arenaAudioAssets,
            closeOnStop: false,
          });

          // Inspect host info on launch to guarantee packaged requirement
          const hostInfo = await currentHost.getHostInfo();
          if (targetMode === "packaged" && !hostInfo.isPackaged) {
            throw new Error(
              `Phase "${phase.id}" expected packaged executable but hostInfo reported isPackaged === false`,
            );
          }
        }

        const runner = new AcceptanceRunner(currentProbe!, {
          ...(this.#options.outputDir ? { artifactDir: this.#options.outputDir } : {}),
        });

        const report = await runner.run(phase.manifest);
        const processId = currentHost?.getProcessId();

        if (phase.persistenceGroup) {
          persistenceEvidence[phase.id] = {
            group: phase.persistenceGroup,
            processId,
            freshProcess: phase.freshProcess,
          };
        }

        if (report.observations?.visualCaptures && typeof report.observations.visualCaptures === "object") {
          for (const [frameId, frameData] of Object.entries(report.observations.visualCaptures)) {
            const evidence = frameData as any;
            visualEvidence[frameId] = {
              phaseId: phase.id,
              sha256: evidence?.sha256,
              width: evidence?.width,
              height: evidence?.height,
              meanLuminance: evidence?.meanLuminance,
              perceptualHash: evidence?.perceptualHash,
            };
          }
        }

        if (report.observations?.performance) {
          const perfEvidence = report.observations.performance as RuntimePerformanceEvidence;
          performanceEvidence = perfEvidence;
          if (this.#options.outputDir) {
            const hostInfo = (await currentHost?.getHostInfo()) as Record<string, unknown> | undefined;
            const perfReport: PerformanceReport = {
              ...(hostInfo ? { hostInfo } : {}),
              suite: plan.suite,
              measuredEvidence: perfEvidence,
              violations: (report.observations.performanceViolations as any) ?? [],
              passed: ((report.observations.performanceViolations as any) ?? []).length === 0,
            };
            await writePerformanceReport(
              join(this.#options.outputDir, "performance-report.json"),
              perfReport,
            );
          }
        }

        const phaseResult: ShippingPhaseResult = {
          id: phase.id,
          ...(phase.name ? { name: phase.name } : {}),
          passed: report.passed,
          processId,
          captureMode: phase.captureMode,
          acceptanceReport: report,
        };

        phaseResults.push(phaseResult);
        this.#options.onPhaseEnd?.(phaseResult, i);

        if (!report.passed) {
          failedPhaseIds.push(phase.id);
          if (!failureReason) {
            failureReason = `Phase "${phase.id}" failed: ${report.failureReason ?? "unknown failure"}`;
          }
        }

        // If the next phase requires a fresh process, close now
        const nextPhase = plan.phases[i + 1];
        if (nextPhase?.freshProcess && currentHost) {
          await currentHost.close();
          currentHost = undefined;
          currentProbe = undefined;
        }
      }
    } finally {
      if (currentHost) {
        await currentHost.close();
        currentHost = undefined;
      }
      if (cleanupSaveDir && existsSync(baseSaveDir)) {
        await rm(baseSaveDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    const passed = failedPhaseIds.length === 0;

    const shippingReport: ShippingAcceptanceReport = {
      suite: plan.suite,
      planSha256,
      planPath,
      passed,
      artifact: {
        execPath,
        sha256: execSha256,
        platform,
        arch,
        isPackaged: targetMode === "packaged",
      },
      phases: phaseResults,
      failedPhaseIds,
      ...(failureReason ? { failureReason } : {}),
      ...(Object.keys(persistenceEvidence).length > 0 ? { persistenceEvidence } : {}),
      ...(Object.keys(visualEvidence).length > 0 ? { visualEvidence } : {}),
      ...(performanceEvidence ? { performanceEvidence } : {}),
    };

    if (this.#options.outputDir) {
      const reportPath = join(this.#options.outputDir, "shipping-report.json");
      await writeFile(reportPath, JSON.stringify(shippingReport, null, 2), "utf8");
    }

    return shippingReport;
  }
}
