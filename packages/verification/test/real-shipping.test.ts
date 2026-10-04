import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canRunRealElectronTests,
  defaultCanonicalPlanPath,
  loadShippingPlan,
  ShippingAcceptanceRunner,
  type ShippingAcceptancePlan,
} from "../src/index.js";

test(
  "P8 Final Gate — Canonical Complete-Game Shipping Acceptance Suite",
  { timeout: 180_000 },
  async (t) => {
    if (!canRunRealElectronTests()) {
      t.skip("Real Electron packaged tests require interactive display or xvfb");
      return;
    }

    const canonicalPath = defaultCanonicalPlanPath();
    assert.ok(existsSync(canonicalPath), `Canonical plan must exist at ${canonicalPath}`);

    const { plan: canonicalPlan, planSha256 } = await loadShippingPlan(canonicalPath);
    let tempArtifactDir: string | undefined;

    // -------------------------------------------------------------------------
    // SCENARIO 1: Full Canonical Shipping Acceptance Run against Packaged Executable
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 1: Canonical shipping plan passes full multi-process packaged execution with state, visuals, and performance",
      async () => {
        tempArtifactDir = await mkdtemp(join(tmpdir(), "kinetra-shipping-artifacts-"));

        const runner = new ShippingAcceptanceRunner({
          planPath: canonicalPath,
          target: "packaged",
          outputDir: tempArtifactDir,
          timeoutMs: 45_000,
        });

        const report = await runner.run();

        // Release-blocking zero tolerance: must pass
        assert.equal(
          report.passed,
          true,
          `Shipping acceptance MUST pass. Failure reason: ${report.failureReason}`,
        );
        assert.equal(report.suite, "kinetra-arena-shipping");
        assert.equal(report.planSha256, planSha256);
        assert.equal(report.failedPhaseIds.length, 0);

        // Packaged artifact provenance
        assert.equal(report.artifact.isPackaged, true, "Artifact must be packaged");
        assert.equal(typeof report.artifact.sha256, "string");
        assert.equal(report.artifact.sha256.length, 64);
        assert.ok(existsSync(report.artifact.execPath));

        // Required phases verified
        assert.ok(report.phases.length >= 6);
        const phaseMap = new Map(report.phases.map((p) => [p.id, p]));

        const phase1 = phaseMap.get("boot-shell-visual");
        const phase2 = phaseMap.get("core-gameplay-save");
        const phase3 = phaseMap.get("continue-victory");
        const phase4 = phaseMap.get("defeat-flow");
        const phase5a = phaseMap.get("settings-mutation");
        const phase5b = phaseMap.get("settings-restore");
        const phase6 = phaseMap.get("steady-state-performance");

        assert.ok(phase1?.passed, "Phase 1 (boot-shell-visual) must pass");
        assert.ok(phase2?.passed, "Phase 2 (core-gameplay-save) must pass");
        assert.ok(phase3?.passed, "Phase 3 (continue-victory) must pass");
        assert.ok(phase4?.passed, "Phase 4 (defeat-flow) must pass");
        assert.ok(phase5a?.passed, "Phase 5a (settings-mutation) must pass");
        assert.ok(phase5b?.passed, "Phase 5b (settings-restore) must pass");
        assert.ok(phase6?.passed, "Phase 6 (steady-state-performance) must pass");

        // Process boundary identity proof: Process A PID != Process B PID
        assert.ok(phase2?.processId, "Phase 2 must record a child processId");
        assert.ok(phase3?.processId, "Phase 3 must record a child processId");
        assert.notEqual(
          phase2?.processId,
          phase3?.processId,
          `Process A PID (${phase2?.processId}) must NOT equal Process B PID (${phase3?.processId}) - real OS process restart required`,
        );

        // Visual evidence presence
        assert.ok(report.visualEvidence, "Visual evidence must be present");
        assert.ok(report.visualEvidence["main-menu"], "Main menu frame must be captured");
        assert.ok(report.visualEvidence["gameplay-hud"], "Gameplay HUD frame must be captured");
        assert.ok(report.visualEvidence["victory"], "Victory frame must be captured");
        assert.ok(report.visualEvidence["defeat"], "Defeat frame must be captured");

        // Performance evidence presence and budget compliance
        assert.ok(report.performanceEvidence, "Performance evidence must be present");
        assert.ok(report.performanceEvidence.renderer.drawCalls <= 150);
        assert.ok(report.performanceEvidence.renderer.triangles <= 300000);
        assert.ok(report.performanceEvidence.frame.p95Ms <= 120);

        // Artifact bundle files created
        assert.ok(existsSync(join(tempArtifactDir, "shipping-report.json")));
        assert.ok(existsSync(join(tempArtifactDir, "performance-report.json")));
        assert.ok(existsSync(join(tempArtifactDir, "main-menu.png")));
        assert.ok(existsSync(join(tempArtifactDir, "gameplay-hud.png")));
        assert.ok(existsSync(join(tempArtifactDir, "victory.png")));
        assert.ok(existsSync(join(tempArtifactDir, "defeat.png")));
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 2: Deliberate Shipping Gate Failure Proof (Section 22)
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 2: Deliberate draw-call budget violation in plan fails aggregator with zero tolerance",
      async () => {
        // Clone canonical plan and inject an impossibly low budget
        const deliberatePlan: ShippingAcceptancePlan = JSON.parse(
          JSON.stringify(canonicalPlan),
        );
        const perfPhase = deliberatePlan.phases.find(
          (p) => p.id === "steady-state-performance",
        );
        assert.ok(perfPhase, "Must have steady-state-performance phase to mutate");

        const budgetStep = perfPhase.manifest.steps.find(
          (s) => s.type === "assert.performanceBudget",
        );
        assert.ok(budgetStep, "Must have assert.performanceBudget step");
        (budgetStep as any).budget = {
          budgets: {
            "renderer.drawCalls": { max: 1 }, // Impossible: Arena has > 1 draw call
          },
        };

        const runner = new ShippingAcceptanceRunner({
          plan: deliberatePlan,
          target: "packaged",
          timeoutMs: 45_000,
        });

        const report = await runner.run(deliberatePlan);

        assert.equal(
          report.passed,
          false,
          "Aggregator MUST refuse bad release when a phase fails",
        );
        assert.ok(
          report.failedPhaseIds.includes("steady-state-performance"),
          `failedPhaseIds must contain steady-state-performance, got: ${JSON.stringify(report.failedPhaseIds)}`,
        );
        assert.ok(
          report.failureReason?.includes("drawCalls") ||
            report.failureReason?.includes("Budget") ||
            report.failureReason?.includes("exceeds"),
          `failureReason must reflect underlying budget failure: ${report.failureReason}`,
        );
      },
    );

    if (tempArtifactDir && existsSync(tempArtifactDir)) {
      await rm(tempArtifactDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
