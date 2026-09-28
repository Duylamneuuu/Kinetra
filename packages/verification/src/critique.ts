import type { RuntimeLog } from "./types.js";
import type { VisualFrameEvidence } from "./visual.js";

export interface VisualCritiqueFinding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  region?: { x: number; y: number; width: number; height: number } | undefined;
  evidence?: Record<string, unknown> | undefined;
}

export interface VisualCritiqueRequest {
  captureId: string;
  framePng: Uint8Array;
  evidence: VisualFrameEvidence;
  rubric: string;
  expectedVisualFacts?: string[] | undefined;
  runtimeState?: Record<string, unknown> | undefined;
  recentLogs?: RuntimeLog[] | undefined;
}

export interface VisualCritiqueReport {
  provider: string;
  model?: string | undefined;
  verdict: "pass" | "fail" | "review";
  findings: VisualCritiqueFinding[];
  durationMs?: number | undefined;
}

export interface VisualCritiqueProvider {
  name: string;
  model?: string | undefined;
  critique(request: VisualCritiqueRequest): Promise<VisualCritiqueReport>;
}

/**
 * Deterministic test/fake critique provider for unit and integration contract testing.
 *
 * @internal Testing-only fixture. Do not use as a production vision critique provider.
 */
export class FakeVisualCritiqueProvider implements VisualCritiqueProvider {
  readonly name: string = "fake-critique-provider";
  readonly model?: string | undefined = "mock-vision-v1";

  readonly recordedRequests: VisualCritiqueRequest[] = [];
  shouldFail = false;
  fixedVerdict?: "pass" | "fail" | "review" | undefined;
  customFindings?: VisualCritiqueFinding[] | undefined;

  async critique(request: VisualCritiqueRequest): Promise<VisualCritiqueReport> {
    if (this.shouldFail) {
      throw new Error("Simulated critique provider failure");
    }

    this.recordedRequests.push(request);

    if (this.customFindings) {
      return {
        provider: this.name,
        model: this.model,
        verdict: this.fixedVerdict ?? "pass",
        findings: this.customFindings,
      };
    }

    const findings: VisualCritiqueFinding[] = [];

    if (request.evidence.meanLuminance < 0.05) {
      findings.push({
        code: "VISUAL_UNDEREXPOSED",
        severity: "warning",
        message: "Frame luminance is very low; visual details may be obscured",
      });
    }

    if (request.expectedVisualFacts) {
      for (const fact of request.expectedVisualFacts) {
        findings.push({
          code: "FACT_VERIFIED",
          severity: "info",
          message: `Verified visual fact: ${fact}`,
        });
      }
    }

    const hasError = findings.some((f) => f.severity === "error");
    const hasWarning = findings.some((f) => f.severity === "warning");
    const verdict = this.fixedVerdict ?? (hasError ? "fail" : hasWarning ? "review" : "pass");

    return {
      provider: this.name,
      model: this.model,
      verdict,
      findings,
    };
  }
}
