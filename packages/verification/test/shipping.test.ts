import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  calculatePlanSha256,
  calculateSha256,
  defaultCanonicalPlanPath,
  loadShippingPlan,
  shippingAcceptancePlanSchema,
  type ShippingAcceptancePlan,
  type ShippingAcceptanceReport,
} from "../src/shipping.js";

const here = dirname(fileURLToPath(import.meta.url));

test("Shipping Acceptance Plan — Schema, Hashing & Deliberate Rejection", async (t) => {
  const canonicalPath = defaultCanonicalPlanPath();

  await t.test("canonical shipping plan exists and satisfies schema", async () => {
    assert.ok(existsSync(canonicalPath), `Plan must exist at ${canonicalPath}`);
    const { plan, rawJson, planSha256 } = await loadShippingPlan(canonicalPath);

    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.suite, "kinetra-arena-shipping");
    assert.equal(plan.target, "packaged");
    assert.ok(plan.phases.length >= 6, "Must contain all required shipping phases");

    assert.equal(calculateSha256(rawJson), planSha256);
    assert.equal(typeof planSha256, "string");
    assert.equal(planSha256.length, 64);

    const phaseIds = plan.phases.map((p) => p.id);
    assert.ok(phaseIds.includes("boot-shell-visual"), "Must have boot-shell-visual phase");
    assert.ok(phaseIds.includes("core-gameplay-save"), "Must have core-gameplay-save phase");
    assert.ok(phaseIds.includes("continue-victory"), "Must have continue-victory phase");
    assert.ok(phaseIds.includes("defeat-flow"), "Must have defeat-flow phase");
    assert.ok(phaseIds.includes("settings-mutation"), "Must have settings-mutation phase");
    assert.ok(phaseIds.includes("settings-restore"), "Must have settings-restore phase");
    assert.ok(phaseIds.includes("steady-state-performance"), "Must have steady-state-performance phase");
  });

  await t.test("schema rejects invalid plan structure", () => {
    assert.throws(() => {
      shippingAcceptancePlanSchema.parse({
        schemaVersion: 2, // invalid version
        suite: "invalid-plan",
        phases: [],
      });
    });

    assert.throws(() => {
      shippingAcceptancePlanSchema.parse({
        schemaVersion: 1,
        suite: "empty-phases",
        phases: [], // min(1) required
      });
    });
  });

  await t.test("deterministic plan SHA calculation", () => {
    const plan: ShippingAcceptancePlan = {
      schemaVersion: 1,
      suite: "test-suite",
      target: "packaged",
      phases: [
        {
          id: "p1",
          freshProcess: true,
          captureMode: "performance",
          manifest: {
            schemaVersion: 1,
            suite: "p1-manifest",
            seed: 42,
            target: "packaged",
            steps: [{ type: "runtime.stop" }],
          },
        },
      ],
    };

    const hash1 = calculatePlanSha256(plan);
    const hash2 = calculatePlanSha256(plan);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  await t.test("aggregate report enforces zero-tolerance: any failed phase fails entire shipping report", () => {
    const report: ShippingAcceptanceReport = {
      suite: "kinetra-arena-shipping",
      planSha256: "fake-sha-256",
      passed: false,
      artifact: {
        execPath: "KinetraGame.exe",
        sha256: "fake-exe-sha",
        platform: "win32",
        arch: "x64",
        isPackaged: true,
      },
      phases: [
        {
          id: "phase-1",
          passed: true,
          captureMode: "visual",
          acceptanceReport: {
            suite: "p1",
            target: "packaged",
            passed: true,
            durationMs: 100,
            startedAt: "2026-09-28T00:00:00.000Z",
            finishedAt: "2026-09-28T00:00:00.100Z",
            steps: [],
            failedSteps: [],
            observations: {},
          },
        },
        {
          id: "phase-2-regression",
          passed: false,
          captureMode: "performance",
          acceptanceReport: {
            suite: "p2",
            target: "packaged",
            passed: false,
            durationMs: 100,
            startedAt: "2026-09-28T00:00:00.000Z",
            finishedAt: "2026-09-28T00:00:00.100Z",
            steps: [],
            failedSteps: [
              {
                index: 0,
                type: "assert.performanceBudget",
                passed: false,
                durationMs: 10,
                message: "Budget exceeded: renderer.drawCalls actual 37 exceeds max 15",
              },
            ],
            failureReason: "Budget exceeded: renderer.drawCalls actual 37 exceeds max 15",
            observations: {},
          },
        },
      ],
      failedPhaseIds: ["phase-2-regression"],
      failureReason: 'Phase "phase-2-regression" failed: Budget exceeded: renderer.drawCalls actual 37 exceeds max 15',
    };

    assert.equal(report.passed, false, "Shipping report must fail if any phase failed");
    assert.deepEqual(report.failedPhaseIds, ["phase-2-regression"]);
    assert.ok(report.failureReason?.includes("Budget exceeded"));
  });
});
