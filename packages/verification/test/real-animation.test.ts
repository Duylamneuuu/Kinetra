import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticAnimatedGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  canRunRealElectronTests,
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p5-real-anim");
const animEntityId = stableId("entity", "p5-anim-box");
const cameraId = stableId("entity", "p5-anim-camera");
const lightId = stableId("entity", "p5-anim-light");
const testAssetId = stableId("asset", "p5-anim-box-glb");

function animationFixtureProject(targetAssetId: string = testAssetId): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p5-real-animation"),
    name: "P5 Real Animation Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Animation Acceptance Scene",
        entities: [
          {
            id: animEntityId,
            name: "AnimatedBox",
            components: {
              Model: {
                assetId: targetAssetId,
              },
              Transform: {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
            },
          },
          {
            id: cameraId,
            name: "MainCamera",
            components: {
              Camera: {
                type: "perspective",
                fov: 50,
                near: 0.1,
                far: 100,
              },
              Transform: {
                position: [0, 2, 5],
                rotation: [-0.2, 0, 0],
              },
            },
          },
          {
            id: lightId,
            name: "KeyLight",
            components: {
              Light: {
                kind: "directional",
                color: "#ffffff",
                intensity: 2.5,
              },
              Transform: {
                position: [3, 5, 4],
              },
            },
          },
        ],
      },
    ],
  };
}

function createTestHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

test(
  "real Electron runtime loads animated GLB, discovers clips, plays via semantic command, advances deterministically, and verifies via AcceptanceRunner",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    // 1. Generate deterministic synthetic animated GLB (MoveX clip, 1.0s, X translation 0 -> 1)
    const glbBytes = await createSyntheticAnimatedGlb({
      meshName: "AnimatedBoxMesh",
      nodeName: "AnimatedBoxNode",
      materialName: "AnimatedBoxMaterial",
      clipName: "MoveX",
      duration: 1.0,
      from: [0, 0, 0],
      to: [1, 0, 0],
    });
    const glbBase64 = Buffer.from(glbBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => animationFixtureProject(testAssetId),
      initialRevision: 1,
      closeOnStop: false,
      assets: {
        [testAssetId]: glbBase64,
      },
    });

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p5-real-animation-playback",
        seed: 42,
        target: "runtime",
        steps: [
          // 1. Boot runtime
          { type: "runtime.start", sceneId },
          { type: "assert.equal", path: "running", expected: true },

          // 2. Verify model loaded
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.loaded",
            expected: true,
          },

          // 3. Verify clip metadata discovery
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.animation.clips.0.name",
            expected: "MoveX",
          },
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.animation.clips.0.duration",
            expected: 1.0,
          },
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.animation.playing",
            expected: false,
          },

          // 4. Verify initial node position is 0
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.nodes.0.position.0",
            expected: 0,
          },

          // 5. Start semantic playback of clip "MoveX" (clamped end-state)
          {
            type: "animation.play",
            entityId: animEntityId,
            clip: "MoveX",
            loop: false,
          },

          // 6. Deterministically step 0.5 seconds
          { type: "runtime.step", steps: 1, deltaSeconds: 0.5 },

          // 7. Verify playback state at midpoint
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.animation.activeClip",
            expected: "MoveX",
          },
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.animation.playing",
            expected: true,
          },
          {
            type: "assert.near",
            path: "state.byName.AnimatedBox.model.animation.time",
            expected: 0.5,
            tolerance: 0.05,
          },
          // 8. Verify animated node moved to expected midpoint (X = 0.5)
          {
            type: "assert.near",
            path: "state.byName.AnimatedBox.model.nodes.0.position.0",
            expected: 0.5,
            tolerance: 0.05,
          },

          // 9. Deterministically step another 0.5 seconds (reaches 1.0s end)
          { type: "runtime.step", steps: 1, deltaSeconds: 0.5 },

          // 10. Verify end-state reached (X = 1.0, time = 1.0)
          {
            type: "assert.near",
            path: "state.byName.AnimatedBox.model.nodes.0.position.0",
            expected: 1.0,
            tolerance: 0.05,
          },
          {
            type: "assert.near",
            path: "state.byName.AnimatedBox.model.animation.time",
            expected: 1.0,
            tolerance: 0.05,
          },

          // 11. Stop animation
          { type: "animation.stop", entityId: animEntityId },
          {
            type: "assert.equal",
            path: "state.byName.AnimatedBox.model.animation.playing",
            expected: false,
          },

          // 12. Capture real PNG screenshot
          { type: "assert.screenshotValidPng", minBytes: 1_000 },

          // 13. Verify zero unexpected error logs during playback
          { type: "assert.logAbsent", minimumLevel: "error" },

          // 14. Clean stop
          { type: "runtime.stop" },
        ],
      };

      const runner = new AcceptanceRunner(probe);
      const report = await runner.run(manifest);

      assert.equal(
        report.passed,
        true,
        `Acceptance report failed: ${JSON.stringify(report.steps.filter((s) => !s.passed))}`,
      );
      assert.equal(report.steps.length, manifest.steps.length);
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "requesting a nonexistent clip produces structured error log evidence without crashing",
  { skip: !canRunRealElectronTests(), timeout: 60_000 },
  async () => {
    const glbBytes = await createSyntheticAnimatedGlb();
    const glbBase64 = Buffer.from(glbBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => animationFixtureProject(testAssetId),
      initialRevision: 1,
      closeOnStop: false,
      assets: {
        [testAssetId]: glbBase64,
      },
    });

    try {
      await probe.start(sceneId, 1);

      // Play nonexistent clip
      await host.playAnimation(animEntityId, "NONEXISTENT_CLIP");

      // Verify runtime is still running and did not crash
      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);

      const entity = (snapshot.state as any).byName?.AnimatedBox;
      assert.ok(entity);
      assert.equal(entity.model?.animation?.playing, false);

      // Verify structured error log was emitted
      const logs = await probe.logs();
      const playFailedLog = logs.find(
        (l) => l.level === "error" && l.message === "animation.playFailed",
      );
      assert.ok(
        playFailedLog,
        "A structured 'animation.playFailed' error log must be recorded for invalid clip",
      );
      assert.equal(playFailedLog.data?.clip, "NONEXISTENT_CLIP");

      await probe.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);

test(
  "lifecycle cleanup: restarting scene resets animation state and leaves zero orphan actions",
  { skip: !canRunRealElectronTests(), timeout: 45_000 },
  async () => {
    const glbBytes = await createSyntheticAnimatedGlb();
    const glbBase64 = Buffer.from(glbBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: () => animationFixtureProject(testAssetId),
      initialRevision: 1,
      closeOnStop: false,
      assets: {
        [testAssetId]: glbBase64,
      },
    });

    try {
      // First session: start, play, step
      await probe.start(sceneId, 1);
      await host.playAnimation(animEntityId, "MoveX", { loop: false });
      await host.step(1, 0.5);

      let snapshot = await probe.snapshot();
      let entity = (snapshot.state as any).byName?.AnimatedBox;
      assert.equal(entity?.model?.animation?.playing, true);
      assert.ok(Math.abs((entity?.model?.animation?.time ?? 0) - 0.5) < 0.05);

      // Stop session
      await probe.stop();

      // Restart session
      await probe.start(sceneId, 2);
      snapshot = await probe.snapshot();
      entity = (snapshot.state as any).byName?.AnimatedBox;
      assert.equal(entity?.model?.loaded, true);
      assert.equal(entity?.model?.animation?.playing, false);
      assert.equal(entity?.model?.animation?.time, 0);

      await probe.stop();
    } finally {
      await probe.close();
      await host.close();
    }
  },
);
