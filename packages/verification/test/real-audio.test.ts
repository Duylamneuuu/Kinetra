import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticWav } from "@kinetra/audio";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import {
  AcceptanceRunner,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  type AcceptanceManifest,
} from "../src/index.js";

const sceneId = stableId("scene", "p6-real-audio-scene");
const boxEntityId = stableId("entity", "p6-audio-box");
const cameraId = stableId("entity", "p6-audio-camera");
const lightId = stableId("entity", "p6-audio-light");
const testAudioAssetId = stableId("asset", "p6-synthetic-wav-ping");

function audioFixtureProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "p6-real-audio"),
    name: "P6 Real Audio Fixture",
    scenes: [
      {
        id: sceneId,
        name: "Audio Acceptance Scene",
        entities: [
          {
            id: boxEntityId,
            name: "AudioBox",
            components: {
              Primitive: {
                kind: "box",
                size: [1, 1, 1],
                color: "#ff6b6b",
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
  "real Electron runtime plays audio by assetId, propagates hierarchical bus gain and mute, and captures frame via AcceptanceRunner",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    // 1. Generate deterministic synthetic WAV (440Hz, 0.5s mono PCM)
    const wavBytes = createSyntheticWav({
      sampleRate: 44100,
      durationSeconds: 0.5,
      frequency: 440,
    });
    const wavBase64 = Buffer.from(wavBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: audioFixtureProject,
      initialRevision: 1,
      closeOnStop: false,
      assets: {
        [testAudioAssetId]: wavBase64,
      },
    });

    try {
      const manifest: AcceptanceManifest = {
        schemaVersion: 1,
        suite: "p6-real-audio-playback-and-hierarchy",
        seed: 42,
        target: "runtime",
        steps: [
          {
            type: "runtime.start",
            sceneId,
          },
          // Verify audio subsystem initialized
          {
            type: "assert.equal",
            path: "state.audio.initialized",
            expected: true,
          },
          // Play audio through semantic command on "sfx" bus with gain 0.9 and looping
          {
            type: "audio.play",
            assetId: testAudioAssetId,
            bus: "sfx",
            gain: 0.9,
            loop: true,
          },
          // Verify structured runtime state exposes assetId, bus, playing, gain, effectiveGain, muted
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.assetId",
            expected: testAudioAssetId,
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.bus",
            expected: "sfx",
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.playing",
            expected: true,
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.gain",
            expected: 0.9,
          },
          {
            type: "assert.near",
            path: "state.audio.activePlaybacks.0.effectiveGain",
            expected: 0.9,
            tolerance: 0.001,
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.muted",
            expected: false,
          },
          // Verify real PNG capture works while audio is actively playing
          {
            type: "assert.screenshotValidPng",
            minBytes: 5000,
          },
          // Modify sfx bus gain to 0.8 and master bus gain to 0.5
          // Effective gain should become 0.5 (master) * 0.8 (sfx) * 0.9 (instance) = 0.36
          {
            type: "audio.setBusGain",
            busId: "sfx",
            gain: 0.8,
          },
          {
            type: "audio.setBusGain",
            busId: "master",
            gain: 0.5,
          },
          {
            type: "assert.near",
            path: "state.audio.activePlaybacks.0.effectiveGain",
            expected: 0.36,
            tolerance: 0.001,
          },
          // Mute master bus: effectiveGain becomes 0, muted becomes true, while child gain remains 0.8
          {
            type: "audio.setBusMuted",
            busId: "master",
            muted: true,
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.effectiveGain",
            expected: 0,
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.muted",
            expected: true,
          },
          // Unmute master bus: effectiveGain restored to 0.36, muted becomes false
          {
            type: "audio.setBusMuted",
            busId: "master",
            muted: false,
          },
          {
            type: "assert.near",
            path: "state.audio.activePlaybacks.0.effectiveGain",
            expected: 0.36,
            tolerance: 0.001,
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.muted",
            expected: false,
          },
          // Stop audio playback
          {
            type: "audio.stop",
          },
          {
            type: "assert.equal",
            path: "state.audio.activePlaybacks.0.playing",
            expected: false,
          },
          // Ensure no errors were logged during audio execution
          {
            type: "assert.logAbsent",
            minimumLevel: "error",
          },
          {
            type: "runtime.stop",
          },
        ],
      };

      const runner = new AcceptanceRunner(probe);
      const report = await runner.run(manifest);

      assert.equal(
        report.passed,
        true,
        `Acceptance report failed: ${JSON.stringify(report.steps.filter((s) => !s.passed), null, 2)}`,
      );
      assert.equal(report.steps.length, manifest.steps.length);
    } finally {
      await probe.close();
    }
  },
);

test(
  "audio runtime handles missing assets, invalid bytes, and unknown buses with structured errors",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: audioFixtureProject,
      initialRevision: 1,
      closeOnStop: false,
    });

    try {
      await probe.start(sceneId, 1);

      // 1. Missing asset
      const missingResult = (await (host as any).playAudio({
        assetId: "nonexistent-asset-id",
        bus: "sfx",
      })) as { success: boolean; error?: string };
      assert.equal(missingResult.success, false);
      assert.match(missingResult.error ?? "", /not found/i);

      // 2. Corrupt/invalid audio bytes
      await probe.registerAsset("corrupt-asset", Buffer.from("NOT_A_WAV_FILE").toString("base64"));
      const corruptResult = (await (host as any).playAudio({
        assetId: "corrupt-asset",
        bus: "sfx",
      })) as { success: boolean; error?: string };
      assert.equal(corruptResult.success, false);
      assert.match(corruptResult.error ?? "", /decode|failed/i);

      // 3. Unknown audio bus
      const unknownBusResult = (await (host as any).playAudio({
        assetId: testAudioAssetId,
        bus: "ghost_bus",
      })) as { success: boolean; error?: string };
      assert.equal(unknownBusResult.success, false);
      assert.match(unknownBusResult.error ?? "", /unknown.*bus/i);

      // 4. Unknown bus for setBusGain should reject
      await assert.rejects(
        () => (host as any).setAudioBusGain("ghost_bus", 0.5),
        /unknown.*bus/i,
      );

      // 5. Verify runtime remains healthy and alive
      const snapshot = await probe.snapshot();
      assert.equal(snapshot.running, true);
    } finally {
      await probe.close();
    }
  },
);

test(
  "runtime stop and restart releases audio playback resources cleanly",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async () => {
    const wavBytes = createSyntheticWav({
      sampleRate: 44100,
      durationSeconds: 0.3,
      frequency: 440,
    });
    const wavBase64 = Buffer.from(wavBytes).toString("base64");

    const host = createTestHost();
    const probe = new KinetraRuntimeProbe({
      host,
      project: audioFixtureProject,
      initialRevision: 1,
      closeOnStop: false,
      assets: {
        [testAudioAssetId]: wavBase64,
      },
    });

    try {
      // Session 1: Start and play audio
      await probe.start(sceneId, 1);
      await (host as any).playAudio({
        assetId: testAudioAssetId,
        bus: "music",
        loop: true,
      });

      const snap1 = await probe.snapshot();
      const audioState1 = snap1.state.audio as { activePlaybacks: Array<{ playing: boolean }> };
      assert.equal(audioState1.activePlaybacks.length, 1);
      assert.equal(audioState1.activePlaybacks[0]!.playing, true);

      // Stop Session 1
      await probe.stop();

      // Session 2: Start fresh
      await probe.start(sceneId, 2);
      const snap2 = await probe.snapshot();
      const audioState2 = snap2.state.audio as {
        initialized: boolean;
        activePlaybacks: Array<{ playing: boolean }>;
      };

      assert.equal(audioState2.initialized, true);
      assert.equal(
        audioState2.activePlaybacks.length,
        0,
        "Session 2 must start with zero leftover playbacks from session 1",
      );
    } finally {
      await probe.close();
    }
  },
);
