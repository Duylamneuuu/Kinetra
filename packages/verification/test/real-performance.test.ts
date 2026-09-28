import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  createArenaProject,
  ARENA_SCENE_ID,
  arenaAudioAssets,
  ARENA_ENEMY_MODEL_ASSET_ID,
  arenaAssets,
} from "@kinetra/reference-game";

import {
  canRunRealElectronTests,
  realElectronLaunchArgs,
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  evaluatePerformanceBudget,
  writePerformanceReport,
  type AcceptanceManifest,
  type RuntimePerformanceEvidence,
  type PerformanceBudgetDefinition,
} from "../src/index.js";

function createHost(options: { captureMode?: "performance" | "visual" } = {}): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    electronArgs: realElectronLaunchArgs(),
    requestTimeoutMs: 30_000,
    ...(options.captureMode ? { captureMode: options.captureMode } : {}),
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

function assertValidPng(bytes: Uint8Array, label: string): void {
  assert.ok(bytes.byteLength > 1000, `${label} PNG must exceed 1000 bytes, got ${bytes.byteLength}`);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < header.length; i++) {
    assert.equal(
      bytes[i],
      header[i],
      `${label} PNG byte[${i}] must match standard PNG magic header`,
    );
  }
}

const BOXES_SCENE_ID = stableId("scene", "p8-boxes-scene");

function createBoxesProject(boxCount: number): ProjectDocument {
  const entities: ProjectDocument["scenes"][0]["entities"] = [
    {
      id: stableId("entity", "camera"),
      name: "MainCamera",
      components: {
        Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
        Transform: {
          position: [0, 6, 16],
          rotation: [-0.3, 0, 0],
        },
      },
    },
    {
      id: stableId("entity", "sun"),
      name: "DirectionalSun",
      components: {
        Light: { kind: "directional", color: "#ffffff", intensity: 2 },
        Transform: { position: [5, 10, 5] },
      },
    },
  ];

  for (let i = 0; i < boxCount; i++) {
    const col = i % 6;
    const row = Math.floor(i / 6);
    entities.push({
      id: stableId("entity", `box-${i}`),
      name: `Box-${i}`,
      components: {
        Primitive: {
          kind: "box",
          size: [1, 1, 1],
          color: (i % 2 === 0) ? "#4488ff" : "#ff8844",
        },
        Transform: {
          position: [col * 2.5 - 6.25, 0.5, row * 2.5 - 6.25],
        },
      },
    });
  }

  return {
    schemaVersion: 1,
    projectId: stableId("project", `boxes-perf-${boxCount}`),
    name: `Boxes Performance Project (${boxCount})`,
    scenes: [
      {
        id: BOXES_SCENE_ID,
        name: "Boxes Performance Scene",
        entities,
      },
    ],
  };
}

const MULTI_ENEMY_SCENE_ID = stableId("scene", "p8-multi-enemy-scene");

function createMultiEnemyProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p8-multi-enemy"),
    name: "Multi-Enemy Workload Project",
    scenes: [
      {
        id: MULTI_ENEMY_SCENE_ID,
        name: "Multi-Enemy Scene",
        entities: [
          {
            id: stableId("entity", "camera"),
            name: "MainCamera",
            components: {
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
              Transform: { position: [0, 3, 8], rotation: [-0.2, 0, 0] },
            },
          },
          {
            id: stableId("entity", "sun"),
            name: "DirectionalSun",
            components: {
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
              Transform: { position: [3, 8, 4] },
            },
          },
          {
            id: stableId("entity", "enemy-1"),
            name: "Enemy1",
            components: {
              Transform: { position: [-2, 0, 0] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
          {
            id: stableId("entity", "enemy-2"),
            name: "Enemy2",
            components: {
              Transform: { position: [2, 0, 0] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
        ],
      },
    ],
  };
}

test(
  "P7/P8 Runtime Performance Telemetry & Acceptance Budget Gate",
  { skip: !canRunRealElectronTests(), timeout: 180_000 },
  async (t) => {
    // -------------------------------------------------------------------------
    // SCENARIO 1: Normal Shipping Renderer Configuration Boundary
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 1: normal runtime defaults to performant shipping config (preserveDrawingBuffer: false)",
      async () => {
        const perfHost = createHost(); // defaults to captureMode: "performance"
        try {
          const hostInfo = await perfHost.getHostInfo();
          assert.equal(
            hostInfo.captureMode,
            "performance",
            "Default hostInfo.captureMode must be 'performance'",
          );
          assert.equal(
            hostInfo.preserveDrawingBuffer,
            false,
            "Default hostInfo.preserveDrawingBuffer must be false for normal shipping runtime",
          );

          await perfHost.start(createBoxesProject(2), BOXES_SCENE_ID, 0);
          const query = await perfHost.query();
          assert.equal(query.running, true);
          assert.equal(
            query.renderer?.captureMode,
            "performance",
            "query.renderer.captureMode must be 'performance'",
          );
          assert.equal(
            query.renderer?.preserveDrawingBuffer,
            false,
            "query.renderer.preserveDrawingBuffer must be false",
          );
        } finally {
          await perfHost.close();
        }

        // Compare against explicit visual capture mode
        const visualHost = createHost({ captureMode: "visual" });
        try {
          const hostInfo = await visualHost.getHostInfo();
          assert.equal(
            hostInfo.captureMode,
            "visual",
            "Explicit visual captureMode must be reported in hostInfo",
          );
          assert.equal(
            hostInfo.preserveDrawingBuffer,
            true,
            "Visual captureMode must enable preserveDrawingBuffer",
          );
        } finally {
          await visualHost.close();
        }
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 2: Performance Sampling Evidence Validation & Monotonic Percentiles
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 2: performance.sample returns structured, monotonic percentiles and real Three.js counters",
      async () => {
        const host = createHost();
        try {
          await host.start(createBoxesProject(4), BOXES_SCENE_ID, 0);

          const evidence = await host.samplePerformance({
            warmupFrames: 5,
            sampleFrames: 25,
            fixedDeltaSeconds: 1 / 60,
          });

          // Exact sample and warmup counts
          assert.equal(evidence.sampleCount, 25, "sampleCount must match requested 25");
          assert.equal(evidence.warmupSamples, 5, "warmupSamples must match requested 5");
          assert.equal(evidence.executionMode, "stepped", "executionMode must be stepped");

          // Percentile monotonicity: p50 <= p95 <= p99 <= max
          assert.ok(
            evidence.frame.p50Ms <= evidence.frame.p95Ms &&
              evidence.frame.p95Ms <= evidence.frame.p99Ms &&
              evidence.frame.p99Ms <= evidence.frame.maxMs,
            `Frame percentiles must be strictly monotonic: ${JSON.stringify(evidence.frame)}`,
          );
          assert.ok(
            evidence.simulation.p50Ms <= evidence.simulation.p95Ms &&
              evidence.simulation.p95Ms <= evidence.simulation.p99Ms &&
              evidence.simulation.p99Ms <= evidence.simulation.maxMs,
            `Simulation percentiles must be strictly monotonic: ${JSON.stringify(evidence.simulation)}`,
          );
          assert.ok(
            evidence.render.p50Ms <= evidence.render.p95Ms &&
              evidence.render.p95Ms <= evidence.render.p99Ms &&
              evidence.render.p99Ms <= evidence.render.maxMs,
            `Render percentiles must be strictly monotonic: ${JSON.stringify(evidence.render)}`,
          );

          // All timing values must be finite and >= 0
          for (const timing of [evidence.frame, evidence.simulation, evidence.render]) {
            assert.ok(Number.isFinite(timing.p50Ms) && timing.p50Ms >= 0);
            assert.ok(Number.isFinite(timing.p95Ms) && timing.p95Ms >= 0);
            assert.ok(Number.isFinite(timing.p99Ms) && timing.p99Ms >= 0);
            assert.ok(Number.isFinite(timing.maxMs) && timing.maxMs >= 0);
          }

          // Authoritative Three.js renderer metrics
          assert.ok(evidence.renderer.drawCalls >= 4, `Must record at least 4 draw calls, got ${evidence.renderer.drawCalls}`);
          assert.ok(evidence.renderer.triangles >= 48, `4 cubes = at least 48 triangles, got ${evidence.renderer.triangles}`);
          assert.ok(evidence.renderer.geometries >= 1, `Must track active geometries, got ${evidence.renderer.geometries}`);

          // Scene metrics
          assert.ok(evidence.scene.objectCount >= 4, `Must track scene objects, got ${evidence.scene.objectCount}`);
          assert.ok(evidence.scene.visibleObjectCount >= 4, `Must track visible objects, got ${evidence.scene.visibleObjectCount}`);
        } finally {
          await host.close();
        }
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 3: Arena Steady-State Performance Budget Pass via AcceptanceRunner
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 3: Arena steady-state performance budget passes AcceptanceRunner verification",
      async () => {
        const host = createHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: true,
        });

        const manifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "arena-performance-acceptance",
          seed: 2026,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: ARENA_SCENE_ID },
            { type: "assert.equal", path: "running", expected: true },
            { type: "runtime.step", steps: 10 },
            {
              type: "performance.sample",
              warmupFrames: 10,
              sampleFrames: 30,
              fixedDeltaSeconds: 1 / 60,
            },
            {
              type: "assert.performanceBudget",
              budget: {
                budgets: {
                  "renderer.drawCalls": { max: 150 },
                  "renderer.triangles": { max: 300000 },
                  "scene.objectCount": { max: 200 },
                  "frame.p95Ms": { max: 120 },
                  "simulation.p95Ms": { max: 80 },
                },
              },
            },
            { type: "runtime.stop" },
          ],
        };

        const runner = new AcceptanceRunner(probe);
        const report = await runner.run(manifest);

        assert.equal(report.passed, true, `Arena budget must pass: ${report.failureReason}`);
        assert.ok(report.observations?.performance, "Report must capture performance evidence");
        assert.equal(
          report.observations.performanceViolations,
          undefined,
          "No budget violations should be recorded on passing run",
        );

        const perf = report.observations.performance as RuntimePerformanceEvidence;
        assert.equal(perf.sampleCount, 30);
        assert.ok(perf.renderer.drawCalls <= 150);
        assert.ok(perf.renderer.triangles <= 300000);
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 4: Deliberate Draw-Call Regression Caught by Performance Budget Gate
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 4: deliberate draw-call regression fails budget deterministically with performance.budgetExceeded; fixed composition passes",
      async () => {
        // A) Defective/regressed composition: 35 separate primitives -> 35+ draw calls
        const regressedProject = createBoxesProject(35);
        const failHost = createHost();
        const failProbe = new KinetraRuntimeProbe({
          host: failHost,
          project: () => regressedProject,
          initialRevision: 0,
          closeOnStop: true,
        });

        const budgetDef: PerformanceBudgetDefinition = {
          budgets: {
            "renderer.drawCalls": { max: 15 },
          },
        };

        const failingManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "draw-call-regression-proof",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: BOXES_SCENE_ID },
            {
              type: "performance.sample",
              warmupFrames: 5,
              sampleFrames: 15,
            },
            {
              type: "assert.performanceBudget",
              budget: budgetDef,
            },
            { type: "runtime.stop" },
          ],
        };

        const failRunner = new AcceptanceRunner(failProbe);
        const failReport = await failRunner.run(failingManifest);

        assert.equal(failReport.passed, false, "Manifest must fail due to draw-call budget violation");
        assert.match(
          failReport.failureReason ?? "",
          /performance\.budgetExceeded/i,
          "Failure reason must indicate performance.budgetExceeded",
        );
        assert.ok(
          failReport.observations?.performanceViolations,
          "Report must list structured performance violations",
        );
        const violations = failReport.observations.performanceViolations as Array<{
          metric: string;
          actual: number;
          limit: number;
        }>;
        assert.ok(violations.length >= 1, "At least one violation must be recorded");
        const drawCallViolation = violations.find((v) => v.metric === "renderer.drawCalls");
        assert.ok(drawCallViolation, "renderer.drawCalls must be reported as violated");
        assert.equal(drawCallViolation?.limit, 15);
        assert.ok(
          drawCallViolation!.actual >= 35,
          `Actual draw calls (${drawCallViolation?.actual}) must be >= 35`,
        );

        // B) Fixed composition: reduced to 2 primitives -> ~2-3 draw calls <= 15
        const fixedProject = createBoxesProject(2);
        const passHost = createHost();
        const passProbe = new KinetraRuntimeProbe({
          host: passHost,
          project: () => fixedProject,
          initialRevision: 0,
          closeOnStop: true,
        });

        const passingManifest: AcceptanceManifest = {
          schemaVersion: 1,
          suite: "draw-call-fixed-proof",
          seed: 42,
          target: "runtime",
          steps: [
            { type: "runtime.start", sceneId: BOXES_SCENE_ID },
            {
              type: "performance.sample",
              warmupFrames: 5,
              sampleFrames: 15,
            },
            {
              type: "assert.performanceBudget",
              budget: budgetDef,
            },
            { type: "runtime.stop" },
          ],
        };

        const passRunner = new AcceptanceRunner(passProbe);
        const passReport = await passRunner.run(passingManifest);
        assert.equal(passReport.passed, true, `Fixed project must pass: ${passReport.failureReason}`);
        assert.equal(passReport.observations?.performanceViolations, undefined);
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 5: Repeated Scene Lifecycle Resource Growth / Leak Check
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 5: repeated stop -> start lifecycle does not monotonically leak renderer resources",
      async () => {
        const host = createHost();
        const project = createBoxesProject(6);

        try {
          // Lifecycle Iteration 1
          await host.start(project, BOXES_SCENE_ID, 0);
          const sample1 = await host.samplePerformance({ warmupFrames: 5, sampleFrames: 15 });
          await host.stop();

          // Lifecycle Iteration 2
          await host.start(project, BOXES_SCENE_ID, 0);
          const sample2 = await host.samplePerformance({ warmupFrames: 5, sampleFrames: 15 });
          await host.stop();

          // Lifecycle Iteration 3
          await host.start(project, BOXES_SCENE_ID, 0);
          const sample3 = await host.samplePerformance({ warmupFrames: 5, sampleFrames: 15 });
          await host.stop();

          // Assert resource counts remain bounded and do not leak
          assert.equal(
            sample3.renderer.geometries,
            sample1.renderer.geometries,
            `Geometries must not grow across lifecycles (${sample1.renderer.geometries} -> ${sample3.renderer.geometries})`,
          );
          assert.equal(
            sample3.renderer.textures,
            sample1.renderer.textures,
            `Textures must not grow across lifecycles (${sample1.renderer.textures} -> ${sample3.renderer.textures})`,
          );
          assert.equal(
            sample3.scene.objectCount,
            sample1.scene.objectCount,
            `Object count must match across lifecycles (${sample1.scene.objectCount} -> ${sample3.scene.objectCount})`,
          );
        } finally {
          await host.close();
        }
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 6: Multi-Instance Character Workload Template Reuse
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 6: multi-instance character workload retains single asset template parse and bounded metrics",
      async () => {
        const host = createHost();
        const project = createMultiEnemyProject();

        try {
          await host.start(project, MULTI_ENEMY_SCENE_ID, 0, arenaAssets);
          const q0 = await host.query();
          assert.equal(q0.running, true);

          // Both entities must share a single parsed template
          assert.equal(
            q0.metrics?.assetTemplateParseCount,
            1,
            "Asset template must be parsed exactly once for both enemy instances",
          );

          const evidence = await host.samplePerformance({ warmupFrames: 5, sampleFrames: 15 });
          assert.equal(
            evidence.scene.modelInstanceCount,
            2,
            "Performance evidence must record 2 model instances",
          );
          assert.ok(
            evidence.scene.skinnedMeshCount >= 2,
            "Performance evidence must record skinned mesh count >= 2",
          );
        } finally {
          await host.close();
        }
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 7: Post-Sampling Visual Capture Verification
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 7: visual capture succeeds truthfully after performance sampling completes",
      async () => {
        const host = createHost();
        try {
          await host.start(createBoxesProject(3), BOXES_SCENE_ID, 0);

          // Run performance sampling first
          const perf = await host.samplePerformance({ warmupFrames: 5, sampleFrames: 15 });
          assert.equal(perf.sampleCount, 15);

          // Capture frame post-sampling
          const capture = await host.captureFrame();
          assert.equal(capture.available, true);
          assert.ok(capture.base64, "Capture base64 payload must be returned");

          const bytes = Buffer.from(capture.base64, "base64");
          assertValidPng(bytes, "Post-sampling frame");
        } finally {
          await host.close();
        }
      },
    );

    // -------------------------------------------------------------------------
    // SCENARIO 8: Compact Performance Report Artifact Generation
    // -------------------------------------------------------------------------
    await t.test(
      "Scenario 8: writePerformanceReport emits machine-readable performance-report.json",
      async () => {
        const tmpDir = await mkdtemp(join(tmpdir(), "kinetra-perf-report-"));
        try {
          const evidence: RuntimePerformanceEvidence = {
            sampleCount: 60,
            warmupSamples: 10,
            executionMode: "stepped",
            frame: { p50Ms: 12.5, p95Ms: 16.2, p99Ms: 18.0, maxMs: 19.5 },
            simulation: { p50Ms: 3.2, p95Ms: 4.5, p99Ms: 5.1, maxMs: 5.5 },
            render: { p50Ms: 8.5, p95Ms: 11.2, p99Ms: 12.3, maxMs: 13.8 },
            renderer: {
              drawCalls: 45,
              triangles: 12500,
              points: 0,
              lines: 0,
              geometries: 18,
              textures: 8,
            },
            scene: {
              objectCount: 25,
              visibleObjectCount: 22,
              modelInstanceCount: 2,
              skinnedMeshCount: 2,
              activeAnimationMixerCount: 2,
            },
            physics: {
              bodyCount: 5,
              colliderCount: 5,
            },
          };

          const budget: PerformanceBudgetDefinition = {
            budgets: {
              "renderer.drawCalls": { max: 100 },
              "frame.p95Ms": { max: 20 },
            },
          };

          const evaluation = evaluatePerformanceBudget(evidence, budget);
          assert.equal(evaluation.passed, true);

          const reportPath = join(tmpDir, "performance-report.json");
          await writePerformanceReport(reportPath, {
            suite: "unit-performance-artifact",
            budget,
            measuredEvidence: evidence,
            violations: evaluation.violations,
            passed: evaluation.passed,
            hostInfo: {
              platform: process.platform,
              arch: process.arch,
              isPackaged: false,
              captureMode: "performance",
              preserveDrawingBuffer: false,
            },
          });

          const content = await readFile(reportPath, "utf-8");
          const report = JSON.parse(content);
          assert.equal(report.passed, true);
          assert.equal(report.suite, "unit-performance-artifact");
          assert.equal(report.measuredEvidence.sampleCount, 60);
          assert.equal(report.measuredEvidence.renderer.drawCalls, 45);
          assert.equal(report.budget.budgets["renderer.drawCalls"].max, 100);
          assert.equal(report.hostInfo.captureMode, "performance");
        } finally {
          await rm(tmpDir, { recursive: true, force: true });
        }
      },
    );
  },
);
