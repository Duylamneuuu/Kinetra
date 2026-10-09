import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeVisualCritiqueProvider,
  type VisualCritiqueFinding,
  type VisualCritiqueRequest,
} from "../src/index.js";

function requestOf(
  meanLuminance: number,
  extra: Partial<VisualCritiqueRequest> = {},
): VisualCritiqueRequest {
  return {
    captureId: "frame",
    framePng: new Uint8Array([0]),
    // Only the field the fake provider reads; the rest of the evidence is irrelevant to it.
    evidence: { meanLuminance } as unknown as VisualCritiqueRequest["evidence"],
    rubric: "rubric",
    ...extra,
  };
}

test("a dark frame is reported as VISUAL_UNDEREXPOSED and the verdict becomes review", async () => {
  const provider = new FakeVisualCritiqueProvider();
  const report = await provider.critique(requestOf(0.01));
  assert.equal(report.verdict, "review");
  assert.deepEqual(
    report.findings.map((finding) => [finding.code, finding.severity]),
    [["VISUAL_UNDEREXPOSED", "warning"]],
  );
});

test("the underexposure threshold is strict: 0.05 itself passes", async () => {
  const provider = new FakeVisualCritiqueProvider();
  assert.equal((await provider.critique(requestOf(0.05))).verdict, "pass");
  assert.equal((await provider.critique(requestOf(0.0499))).verdict, "review");
});

test("expected visual facts become info findings in order and keep the verdict at pass", async () => {
  const provider = new FakeVisualCritiqueProvider();
  const report = await provider.critique(requestOf(0.5, { expectedVisualFacts: ["b fact", "a fact"] }));
  assert.equal(report.verdict, "pass");
  assert.deepEqual(
    report.findings.map((finding) => finding.message),
    ["Verified visual fact: b fact", "Verified visual fact: a fact"],
  );
  assert.ok(report.findings.every((finding) => finding.code === "FACT_VERIFIED" && finding.severity === "info"));
});

test("fixedVerdict overrides the computed verdict but findings are still reported", async () => {
  const provider = new FakeVisualCritiqueProvider();
  provider.fixedVerdict = "fail";
  const report = await provider.critique(requestOf(0.9, { expectedVisualFacts: ["x"] }));
  assert.equal(report.verdict, "fail");
  assert.equal(report.findings.length, 1);
  assert.equal(report.provider, "fake-critique-provider");
  assert.equal(report.model, "mock-vision-v1");
});

test("customFindings replace the computed findings entirely; verdict defaults to pass unless fixed", async () => {
  const provider = new FakeVisualCritiqueProvider();
  const custom: VisualCritiqueFinding[] = [{ code: "HUD_CLIPPED", severity: "error", message: "HUD is cut off" }];
  provider.customFindings = custom;
  // A dark frame and expected facts would normally add findings; custom findings win.
  const report = await provider.critique(requestOf(0, { expectedVisualFacts: ["ignored"] }));
  assert.deepEqual(report.findings, custom);
  // Documented behaviour of the fixture: an error finding in customFindings does not by itself flip the verdict.
  assert.equal(report.verdict, "pass");

  provider.fixedVerdict = "review";
  assert.equal((await provider.critique(requestOf(0))).verdict, "review");
});

test("a failing provider throws before recording the request; recovering resumes recording", async () => {
  const provider = new FakeVisualCritiqueProvider();
  provider.shouldFail = true;
  await assert.rejects(() => provider.critique(requestOf(0.5)), /Simulated critique provider failure/);
  assert.equal(provider.recordedRequests.length, 0);

  provider.shouldFail = false;
  const request = requestOf(0.5);
  await provider.critique(request);
  assert.deepEqual(provider.recordedRequests, [request]);
});
