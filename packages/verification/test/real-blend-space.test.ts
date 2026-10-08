import assert from "node:assert/strict";
import test from "node:test";

import type {
  BlendSpace1DDefinition,
  BlendSpace2DDefinition,
} from "@kinetra/animation/blend-space.js";
import type { ProjectDocument } from "@kinetra/project-model";
import { ARENA_ENEMY_MODEL_ASSET_ID, arenaAssets } from "@kinetra/reference-game";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
  type RuntimeEntityState,
} from "../src/index.js";

const SCENE_ID = "scene_blend_space";
const ENTITY_BLENDED = "entity_blend_bot";
const ENTITY_REFERENCE = "entity_reference_bot";

function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    electronArgs: realElectronLaunchArgs(),
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

/** Two script-free rigged bots so nothing but the test drives their animation. */
function createBlendSpaceProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_blend_space_verification",
    name: "Blend Space Verification Project",
    scenes: [
      {
        id: SCENE_ID,
        name: "Blend Space Scene",
        entities: [
          {
            id: "camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 2, 6], rotation: [-0.1, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
            },
          },
          {
            id: "sun",
            name: "Sun",
            components: {
              Transform: { position: [2, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
            },
          },
          {
            id: "floor",
            name: "Floor",
            components: {
              Transform: { position: [0, -0.05, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Primitive: { kind: "box", size: [12, 0.1, 12], color: "#1a1e28" },
            },
          },
          {
            id: ENTITY_BLENDED,
            name: "BlendBot",
            components: {
              Transform: { position: [-1.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
          {
            id: ENTITY_REFERENCE,
            name: "ReferenceBot",
            components: {
              Transform: { position: [1.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
        ],
      },
    ],
  };
}

const SPEED_SPACE: BlendSpace1DDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "bot_speed",
  parameter: "speed",
  samples: [
    { clipId: "idle", position: 0 },
    { clipId: "walk", position: 1 },
    { clipId: "attack", position: 2 },
  ],
};

const STRAFE_SPACE: BlendSpace2DDefinition = {
  schemaVersion: 1,
  kind: "2d",
  id: "bot_strafe",
  parameters: ["velocityX", "velocityZ"],
  samples: [
    { clipId: "idle", position: [0, 0] },
    { clipId: "walk", position: [0, 1] },
    { clipId: "telegraph", position: [1, 0] },
    { clipId: "hurt", position: [-1, 0] },
  ],
};

function entity(entities: RuntimeEntityState[], id: string): RuntimeEntityState {
  const found = entities.find((e) => e.entityId === id);
  assert.ok(found, `entity ${id} must be in the query result`);
  return found;
}

function weightOf(weights: Array<{ clip: string; weight: number }> | undefined, clip: string): number {
  return weights?.find((w) => w.clip === clip)?.weight ?? 0;
}

function assertValidPng(bytes: Uint8Array, label: string): void {
  assert.ok(bytes.byteLength > 1000, `${label} PNG must exceed 1000 bytes, got ${bytes.byteLength}`);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < header.length; i++) {
    assert.equal(bytes[i], header[i], `${label} PNG byte[${i}] must match PNG magic`);
  }
}

test(
  "Runtime locomotion blend space vertical slice",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    await t.test(
      "Scenario 1: 1D blend space weights, phase-synced stepping, input updates, structured errors and takeover",
      async () => {
        const host = createHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createBlendSpaceProject(),
          initialRevision: 0,
          assets: arenaAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(SCENE_ID, 801);

          const played = await host.playBlendSpace(ENTITY_BLENDED, SPEED_SPACE, { input: { speed: 0.5 } });
          assert.equal(played.success, true, played.error);
          const anim0 = entity(played.entities, ENTITY_BLENDED).model?.animation;
          assert.ok(anim0?.blendSpace, "blend space state must be observable");
          assert.equal(anim0.blendSpace.id, "bot_speed");
          assert.equal(anim0.blendSpace.kind, "1d");
          assert.deepEqual(anim0.blendSpace.input, { speed: 0.5 });
          assert.ok(Math.abs(weightOf(anim0.blendSpace.weights, "idle") - 0.5) < 1e-9);
          assert.ok(Math.abs(weightOf(anim0.blendSpace.weights, "walk") - 0.5) < 1e-9);
          assert.equal(anim0.blendSpace.phase, 0);
          assert.ok(anim0.actions?.every((a) => a.role === "blend"), "actions report the blend role");
          assert.equal(anim0.playing, true);

          // Expected cycle = weighted clip durations taken from the runtime's own clip table.
          const duration = (name: string): number => {
            const clip = anim0.clips.find((c) => c.name === name);
            assert.ok(clip, `clip ${name} must exist`);
            return clip.duration;
          };
          const expectedCycle = 0.5 * duration("idle") + 0.5 * duration("walk");
          assert.ok(Math.abs(anim0.blendSpace.cycleDuration - expectedCycle) < 1e-9);

          const stepped = await host.step(12, 1 / 60);
          const anim1 = entity(stepped.entities, ENTITY_BLENDED).model?.animation;
          const expectedPhase = (0.2 / expectedCycle) % 1;
          assert.ok(
            Math.abs((anim1?.blendSpace?.phase ?? -1) - expectedPhase) < 1e-6,
            `phase ${anim1?.blendSpace?.phase} must equal ${expectedPhase}`,
          );

          const frame = await probe.captureFrame();
          assertValidPng(frame, "Blend space playback");

          const moved = await host.setBlendSpaceInput(ENTITY_BLENDED, { speed: 1.75 });
          assert.equal(moved.success, true, moved.error);
          const anim2 = entity(moved.entities, ENTITY_BLENDED).model?.animation;
          assert.ok(Math.abs(weightOf(anim2?.blendSpace?.weights, "walk") - 0.25) < 1e-9);
          assert.ok(Math.abs(weightOf(anim2?.blendSpace?.weights, "attack") - 0.75) < 1e-9);
          assert.equal(anim2?.activeClip, "attack", "dominant clip is reported as activeClip");

          // Structured failures leave the playing blend space untouched.
          const unknownAxis = await host.setBlendSpaceInput(ENTITY_BLENDED, { sideways: 1 });
          assert.equal(unknownAxis.success, false);
          assert.equal(unknownAxis.code, "anim.blendSpace.input.unknownParameter");
          const unknownClip = await host.playBlendSpace(ENTITY_BLENDED, {
            ...SPEED_SPACE,
            samples: [...SPEED_SPACE.samples, { clipId: "sprint", position: 3 }],
          });
          assert.equal(unknownClip.success, false);
          assert.equal(unknownClip.code, "anim.blendSpace.clip.unknown");
          const invalid = await host.playBlendSpace(ENTITY_BLENDED, { ...SPEED_SPACE, samples: [] });
          assert.equal(invalid.code, "anim.blendSpace.samples.empty");
          const notPlaying = await host.setBlendSpaceInput(ENTITY_REFERENCE, { speed: 1 });
          assert.equal(notPlaying.code, "anim.blendSpace.notPlaying");

          const afterErrors = await host.query({ entityIds: [ENTITY_BLENDED] });
          const anim3 = entity(afterErrors.entities, ENTITY_BLENDED).model?.animation;
          assert.deepEqual(anim3?.blendSpace?.input, { speed: 1.75 });
          assert.equal(anim3?.blendSpace?.id, "bot_speed");

          // Direct playback takes over from the blend space.
          const crossfaded = await host.crossfadeAnimation(ENTITY_BLENDED, "idle", 0.2);
          assert.equal(crossfaded.success, true);
          await host.step(15, 1 / 60);
          const afterTakeover = await host.query({ entityIds: [ENTITY_BLENDED] });
          const anim4 = entity(afterTakeover.entities, ENTITY_BLENDED).model?.animation;
          assert.equal(anim4?.blendSpace, undefined);
          assert.deepEqual(anim4?.actions, [{ clip: "idle", weight: 1, role: "active" }]);

          // Replay and stop.
          assert.equal((await host.playBlendSpace(ENTITY_BLENDED, SPEED_SPACE)).success, true);
          const stopped = await host.stopAnimation(ENTITY_BLENDED);
          const anim5 = entity(stopped.entities, ENTITY_BLENDED).model?.animation;
          assert.equal(anim5?.blendSpace, undefined);
          assert.equal(anim5?.playing, false);

          const logs = await probe.logs();
          assert.ok(logs.some((l) => l.message === "animation.blendSpace.played"));
          assert.ok(logs.some((l) => l.message === "animation.blendSpace.playFailed"));
          assert.ok(logs.some((l) => l.message === "animation.blendSpace.inputFailed"));
          assert.ok(!logs.some((l) => l.message === "model.loadFailed"));
        } finally {
          await probe.close();
        }
      },
    );

    await t.test(
      "Scenario 2: a 2D blend space at a sample poses the rig exactly like the single clip, and blends off-sample",
      async () => {
        const host = createHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createBlendSpaceProject(),
          initialRevision: 0,
          assets: arenaAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(SCENE_ID, 802);
          const played = await host.playBlendSpace(ENTITY_BLENDED, STRAFE_SPACE, {
            input: { velocityX: 0, velocityZ: 1 },
          });
          assert.equal(played.success, true, played.error);
          assert.equal((await host.playAnimation(ENTITY_REFERENCE, "walk")).entities.length > 0, true);

          const stepped = await host.step(20, 1 / 30);
          const blended = entity(stepped.entities, ENTITY_BLENDED).model?.nodes ?? [];
          const reference = entity(stepped.entities, ENTITY_REFERENCE).model?.nodes ?? [];
          assert.ok(blended.length >= 7, "rig nodes must be observable");
          assert.equal(blended.length, reference.length);
          for (let i = 0; i < blended.length; i++) {
            const a = blended[i]!;
            const b = reference[i]!;
            assert.equal(a.name, b.name);
            const rotA = a.rotation ?? [0, 0, 0, 1];
            const rotB = b.rotation ?? [0, 0, 0, 1];
            for (let k = 0; k < 4; k++) {
              assert.ok(Math.abs(rotA[k]! - rotB[k]!) < 1e-5, `${a.name} rotation[${k}] ${rotA[k]} vs ${rotB[k]}`);
            }
          }

          const diagonal = await host.setBlendSpaceInput(ENTITY_BLENDED, { velocityX: 0.5, velocityZ: 0.5 });
          assert.equal(diagonal.success, true, diagonal.error);
          const weights = entity(diagonal.entities, ENTITY_BLENDED).model?.animation?.blendSpace?.weights ?? [];
          assert.ok(weights.length >= 2, "off-sample input blends at least two clips");
          assert.ok(Math.abs(weights.reduce((sum, w) => sum + w.weight, 0) - 1) < 1e-9);
          assert.equal(weightOf(weights, "hurt"), 0, "the opposite side of the space does not contribute");

          await host.step(10, 1 / 30);
          const frame = await probe.captureFrame();
          assertValidPng(frame, "2D blend space playback");
        } finally {
          await probe.close();
        }
      },
    );
  },
);
