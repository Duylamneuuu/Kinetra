import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { NodeIO } from "@gltf-transform/core";

import {
  extractRootMotionFromClip,
  inspectClipRootMotion,
  type AnimationGraphDefinition,
  type RootMotionInspectionReport,
} from "@kinetra/animation";
import type { ProjectDocument, SceneDefinition } from "@kinetra/project-model";
import {
  arenaAudioAssets,
  ROOT_MOTION_BOT_MODEL_ASSET_ID,
  ROOT_MOTION_BOT_GLB_BASE64,
} from "@kinetra/reference-game";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

async function loadGlbClips(bytes: Uint8Array): Promise<THREE.AnimationClip[]> {
  const io = new NodeIO();
  const doc = await io.readBinary(bytes);
  const result: THREE.AnimationClip[] = [];
  for (const anim of doc.getRoot().listAnimations()) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const channel of anim.listChannels()) {
      const targetNode = channel.getTargetNode();
      const path = channel.getTargetPath();
      const sampler = channel.getSampler();
      if (!targetNode || !sampler) continue;
      const times = sampler.getInput()!.getArray()!;
      const values = sampler.getOutput()!.getArray()!;
      if (path === "translation") {
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${targetNode.getName()}.position`,
            times as any,
            values as any,
          ),
        );
      } else if (path === "rotation") {
        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${targetNode.getName()}.quaternion`,
            times as any,
            values as any,
          ),
        );
      }
    }
    result.push(new THREE.AnimationClip(anim.getName(), -1, tracks));
  }
  return result;
}

function findRepoFile(relPath: string): string {
  let curr = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(curr, relPath);
    if (existsSync(candidate)) return candidate;
    curr = dirname(curr);
  }
  return resolve(process.cwd(), relPath);
}

function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    electronArgs: realElectronLaunchArgs(),
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

const ROOT_CHAR_ENTITY_ID = "root_char";
const WALL_ENTITY_ID = "solid_obstacle";
const EMPTY_SCENE_ID = "scene_root_motion_empty";
const OBSTACLE_SCENE_ID = "scene_root_motion_obstacle";

const rootMotionAssets: Record<string, string> = {
  ...arenaAudioAssets,
  [ROOT_MOTION_BOT_MODEL_ASSET_ID]: ROOT_MOTION_BOT_GLB_BASE64,
};

function createEmptyRootMotionProject(): ProjectDocument {
  const emptyScene: SceneDefinition = {
    id: EMPTY_SCENE_ID,
    name: "Root Motion Empty Test Scene",
    entities: [
      {
        id: "floor",
        name: "Floor",
        components: {
          Transform: { position: [0, -0.5, 0] },
          Primitive: { kind: "box", size: [50, 1, 50] },
          RigidBody: { type: "fixed" },
          Collider: { shape: "box", size: [50, 1, 50] },
        },
      },
      {
        id: ROOT_CHAR_ENTITY_ID,
        name: "RootMotionCharacter",
        components: {
          Transform: { position: [0, 0, 0] },
          Model: { assetId: ROOT_MOTION_BOT_MODEL_ASSET_ID },
          CharacterBody: { speed: 5 },
          Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
        },
      },
      {
        id: "camera",
        name: "Main Camera",
        components: {
          Transform: { position: [0, 3, -5], rotation: [0.2, Math.PI, 0] },
          Camera: { type: "perspective", fov: 60 },
        },
      },
      {
        id: "light",
        name: "Directional Light",
        components: {
          Transform: { position: [5, 10, 5] },
          Light: { kind: "directional", color: "#ffffff", intensity: 1.2 },
        },
      },
    ],
  };

  return {
    schemaVersion: 1,
    projectId: "proj_root_motion_empty",
    name: "Root Motion Empty Test Project",
    scenes: [emptyScene],
  };
}

function createObstacleRootMotionProject(): ProjectDocument {
  const obstacleScene: SceneDefinition = {
    id: OBSTACLE_SCENE_ID,
    name: "Root Motion Obstacle Test Scene",
    entities: [
      {
        id: "floor",
        name: "Floor",
        components: {
          Transform: { position: [0, -0.5, 0] },
          Primitive: { kind: "box", size: [30, 1, 30] },
          RigidBody: { type: "fixed" },
          Collider: { shape: "box", size: [30, 1, 30] },
        },
      },
      // Solid wall placed at z = 2.0, halfExtents: [5, 2, 0.25], so front surface is at z = 1.75
      {
        id: WALL_ENTITY_ID,
        name: "SolidWall",
        components: {
          Transform: { position: [0, 1, 2.0] },
          Primitive: { kind: "box", size: [10, 4, 0.5] },
          RigidBody: { type: "fixed" },
          Collider: { shape: "box", size: [10, 4, 0.5] },
        },
      },
      {
        id: ROOT_CHAR_ENTITY_ID,
        name: "RootMotionCharacter",
        components: {
          Transform: { position: [0, 0, 0] },
          Model: { assetId: ROOT_MOTION_BOT_MODEL_ASSET_ID },
          CharacterBody: { speed: 5 },
          Collider: { shape: "capsule", halfHeight: 0.5, radius: 0.4 },
        },
      },
      {
        id: "camera",
        name: "Main Camera",
        components: {
          Transform: { position: [0, 3, -5], rotation: [0.2, Math.PI, 0] },
          Camera: { type: "perspective", fov: 60 },
        },
      },
      {
        id: "light",
        name: "Directional Light",
        components: {
          Transform: { position: [5, 10, 5] },
          Light: { kind: "directional", color: "#ffffff", intensity: 1.2 },
        },
      },
    ],
  };

  return {
    schemaVersion: 1,
    projectId: "proj_root_motion_obstacle",
    name: "Root Motion Obstacle Test Project",
    scenes: [obstacleScene],
  };
}

const testGraphDefinition: AnimationGraphDefinition = {
  schemaVersion: 1,
  entryState: "idle",
  parameters: {
    moving: { type: "bool", default: false },
    hurt: { type: "trigger" },
    defeated: { type: "bool", default: false },
  },
  states: [
    { id: "idle", clipId: "idle", loop: true },
    { id: "walk", clipId: "walk_root", loop: true },
    { id: "hurt", clipId: "hurt", loop: false },
    { id: "defeat", clipId: "defeat", loop: false },
  ],
  transitions: [
    {
      id: "to-defeat",
      from: "*",
      to: "defeat",
      priority: 100,
      blendSeconds: 0.15,
      conditions: [{ parameter: "defeated", op: "==", value: true }],
    },
    {
      id: "to-hurt",
      from: "*",
      to: "hurt",
      priority: 50,
      blendSeconds: 0.1,
      conditions: [{ parameter: "hurt", op: "triggered" }],
    },
    {
      id: "idle-to-walk",
      from: "idle",
      to: "walk",
      priority: 10,
      blendSeconds: 0.2,
      conditions: [{ parameter: "moving", op: "==", value: true }],
    },
    {
      id: "walk-to-idle",
      from: "walk",
      to: "idle",
      priority: 10,
      blendSeconds: 0.2,
      conditions: [{ parameter: "moving", op: "==", value: false }],
    },
  ],
};

test(
  "Deterministic Root Motion → Rapier Character Motion Vertical Slice",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Requirement 1 & 3: Truthful Source Inspection (CesiumMan vs Root-Motion)
    // -----------------------------------------------------------------------
    await t.test(
      "Requirement 1 & 3: Truthful source inspection determines CesiumMan is in-place while RootMotionBot is locomotion",
      async () => {
        const cesiumPath = findRepoFile("examples/reference-game/assets/characters/cesium-man.glb");
        assert.ok(existsSync(cesiumPath), "CesiumMan GLB must exist");
        const cesiumBytes = readFileSync(cesiumPath);

        const cesiumClips = await loadGlbClips(cesiumBytes);
        assert.ok(cesiumClips.length > 0, "CesiumMan must contain animations");

        const cesiumReport: RootMotionInspectionReport = inspectClipRootMotion(cesiumClips[0]!, "Skeleton_torso_joint_1");
        // Truthful verification: CesiumMan net displacement is ~4mm over 2.0s
        assert.equal(cesiumReport.classification, "in-place");
        assert.equal(cesiumReport.isLocomotion, false);
        const cesiumNetDist = Math.hypot(cesiumReport.netDisplacement[0], cesiumReport.netDisplacement[2]);
        assert.ok(
          cesiumNetDist < 0.05,
          `CesiumMan net XZ displacement must be < 5cm (was ${cesiumNetDist.toFixed(4)}m)`,
        );
        assert.ok(
          cesiumReport.reason.includes("in-place"),
          `CesiumMan reason must truthfully state in-place: ${cesiumReport.reason}`,
        );

        // Synthetic root motion fixture inspection
        const rootBotBytes = readFileSync(
          findRepoFile("examples/reference-game/assets/characters/root-motion-bot.glb"),
        );
        const rootBotClips = await loadGlbClips(rootBotBytes);
        const walkRootClip = rootBotClips.find((a) => a.name === "walk_root");
        assert.ok(walkRootClip, "RootMotionBot must contain walk_root clip");

        const rootBotReport = inspectClipRootMotion(walkRootClip, "Hips");
        assert.equal(rootBotReport.classification, "locomotion");
        assert.equal(rootBotReport.isLocomotion, true);
        const rootNetDist = Math.hypot(rootBotReport.netDisplacement[0], rootBotReport.netDisplacement[2]);
        assert.ok(
          rootNetDist > 1.5,
          `RootMotionBot net forward displacement must exceed 1.5m, got ${rootNetDist.toFixed(4)}m`,
        );
      },
    );

    // -----------------------------------------------------------------------
    // Requirement 2 & 3: Extraction produces deterministic XZ deltas & strips visual root
    // -----------------------------------------------------------------------
    await t.test(
      "Requirement 2 & 3: extractRootMotionFromClip produces deterministic deltas and locks visual XZ while keeping Y bobbing",
      async () => {
        const rootBotBytes = readFileSync(
          findRepoFile("examples/reference-game/assets/characters/root-motion-bot.glb"),
        );
        const rootBotClips = await loadGlbClips(rootBotBytes);
        const walkRootClip = rootBotClips.find((a) => a.name === "walk_root")!;

        const extracted = extractRootMotionFromClip(walkRootClip, {
          mode: "extract-xz",
          rootBoneName: "Hips",
        });
        assert.equal(extracted.success, true);
        assert.ok(extracted.extracted);
        assert.equal(extracted.extracted.mode, "extract-xz");

        // Verify visual inPlaceClip has zeroed X and Z but preserved Y
        const inPlaceTrack = extracted.extracted.inPlaceClip.tracks.find(
          (t) => t.name === "Hips.position",
        ) as THREE.VectorKeyframeTrack;
        assert.ok(inPlaceTrack);

        for (let i = 0; i < inPlaceTrack.times.length; i++) {
          assert.equal(inPlaceTrack.values[i * 3 + 0], 0, `Visual X must be locked at keyframe ${i}`);
          assert.equal(inPlaceTrack.values[i * 3 + 2], 0, `Visual Z must be locked at keyframe ${i}`);
        }
        // Y bobbing remains dynamic
        const y0 = inPlaceTrack.values[1]!;
        const y1 = inPlaceTrack.values[4]!;
        assert.ok(Math.abs(y1 - y0) > 0.01, "Visual Y height must vary (hip bobbing preserved)");
      },
    );

    // -----------------------------------------------------------------------
    // Scenario A: Empty-space locomotion, step determinism, loop boundary, and visual in-place proof
    // -----------------------------------------------------------------------
    await t.test(
      "Requirements 4-8, 11-13: Empty-space root motion drives Rapier character, no double motion, loop boundary clean",
      async () => {
        const host = createHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createEmptyRootMotionProject(),
          initialRevision: 0,
          assets: rootMotionAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(EMPTY_SCENE_ID, 801);

          // Configure root motion mode
          const configRes = await host.configureRootMotion({
            entityId: ROOT_CHAR_ENTITY_ID,
            enabled: true,
            mode: "extract-xz",
            rootBoneName: "Hips",
          });
          assert.equal(configRes.success, true, "configureRootMotion must succeed");

          // Play root motion walk clip
          await host.crossfadeAnimation(ROOT_CHAR_ENTITY_ID, "walk_root", 0);

          // Verify initial state
          let q = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          let char = q.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID);
          assert.ok(char);
          assert.equal(char.position[2], 0);

          // Step 60 times at 1/60s = 1.0 second = 1 full loop
          // Forward displacement should be ~1.6m
          await host.step(60, 1 / 60);

          q = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          char = q.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID);
          assert.ok(char);

          // World position moved through Rapier
          const posZ = char.position[2];
          assert.ok(
            Math.abs(posZ - 1.6) < 0.05,
            `Expected entity world Z position ~1.6m, got ${posZ.toFixed(4)}m`,
          );

          // Verify structured root motion observation
          const rmState = char.gameplay?.rootMotion;
          assert.ok(rmState, "entity.gameplay.rootMotion must be exposed");
          assert.equal(rmState.enabled, true);
          assert.equal(rmState.mode, "extract-xz");
          assert.equal(rmState.collisionClipped, false);
          assert.ok(
            Math.abs(rmState.accumulatedDistance - 1.6) < 0.05,
            `accumulatedDistance must be ~1.6m, got ${rmState.accumulatedDistance.toFixed(4)}m`,
          );

          // Visual skeleton in-place proof:
          // The visual skeleton's Hips node position relative to model scene origin remains 0 on X and Z!
          const hipsNode = char.model?.nodes?.find((n) => n.name === "Hips");
          if (hipsNode) {
            assert.ok(
              Math.abs(hipsNode.position[0]) < 1e-4,
              `Visual skeleton Hips X must remain 0, got ${hipsNode.position[0]}`,
            );
            assert.ok(
              Math.abs(hipsNode.position[2]) < 1e-4,
              `Visual skeleton Hips Z must remain 0 (no double motion), got ${hipsNode.position[2]}`,
            );
          }

          // Loop boundary correctness: step another 60 steps = loop 2
          await host.step(60, 1 / 60);
          q = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          char = q.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID);
          assert.ok(char);
          assert.ok(
            Math.abs(char.position[2] - 3.2) < 0.08,
            `Expected entity world Z ~3.2m after 2 loops, got ${char.position[2].toFixed(4)}m`,
          );
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario B: Real Collision Proof with Solid Obstacle (Requirements 9, 10)
    // -----------------------------------------------------------------------
    await t.test(
      "Requirements 9 & 10: Real solid obstacle collision clips displacement, prevents tunneling (actual < requested)",
      async () => {
        const host = createHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createObstacleRootMotionProject(),
          initialRevision: 0,
          assets: rootMotionAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(OBSTACLE_SCENE_ID, 802);

          // Configure root motion
          await host.configureRootMotion({
            entityId: ROOT_CHAR_ENTITY_ID,
            enabled: true,
            mode: "extract-xz",
            rootBoneName: "Hips",
          });

          // Play walk_root forward towards solid obstacle at z = 2.0 (surface at z = 1.75)
          await host.crossfadeAnimation(ROOT_CHAR_ENTITY_ID, "walk_root", 0);

          // Step 120 times = 2.0s = 3.2m desired forward motion
          // Wall surface is at z = 1.75; capsule radius is 0.4 -> maximum allowed z is 1.35m
          await host.step(120, 1 / 60);

          const q = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          const char = q.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID);
          assert.ok(char);

          // Central proof:
          // 1. Character stopped in front of obstacle
          assert.ok(
            char.position[2] < 1.38,
            `Character tunneled through obstacle! Z position: ${char.position[2]} (expected < 1.38)`,
          );
          assert.ok(
            char.position[2] > 1.25,
            `Character did not reach obstacle! Z position: ${char.position[2]} (expected > 1.25)`,
          );

          // 2. Structured observation proves requestedDelta != appliedDelta and collisionClipped == true
          const rm = char.gameplay?.rootMotion;
          assert.ok(rm, "Root motion gameplay state must exist");
          assert.equal(rm.collisionClipped, true, "collisionClipped must be true when blocked");
          assert.ok(
            rm.blockedDelta[2] > 0.01,
            `blockedDelta.z must be positive, got ${rm.blockedDelta[2]}`,
          );
          assert.ok(
            rm.appliedDelta[2] < rm.requestedDelta[2],
            `actual displacement must be strictly less than requested: ${rm.appliedDelta[2]} < ${rm.requestedDelta[2]}`,
          );

          // Stepping more steps still does not tunnel!
          await host.step(60, 1 / 60);
          const q2 = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          const char2 = q2.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID);
          assert.ok(char2!.position[2] < 1.38, "Character must not creep or tunnel on additional steps");
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario C: Animation Graph Crossfade Ownership & Interruption (Requirements 14, 15)
    // -----------------------------------------------------------------------
    await t.test(
      "Requirements 14 & 15: Graph crossfade walk->idle does not double displacement, and walk->hurt clears motion ownership",
      async () => {
        const host = createHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createEmptyRootMotionProject(),
          initialRevision: 0,
          assets: rootMotionAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(EMPTY_SCENE_ID, 803);

          await host.configureRootMotion({
            entityId: ROOT_CHAR_ENTITY_ID,
            enabled: true,
            mode: "extract-xz",
            rootBoneName: "Hips",
          });

          await host.initAnimationGraph(ROOT_CHAR_ENTITY_ID, testGraphDefinition);

          // Transition idle -> walk
          await host.setAnimationGraphParameter(ROOT_CHAR_ENTITY_ID, "moving", true);
          // Step 30 steps = 0.5s of forward locomotion (~0.8m)
          await host.step(30, 1 / 60);

          const qWalk = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          const zAfterWalk = qWalk.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID)!.position[2];
          assert.ok(zAfterWalk > 0.5, `Walk must have moved forward, got ${zAfterWalk}`);

          // Transition walk -> idle (blend 0.2s)
          // Under ownership rule: incoming state (idle) owns root motion -> requested delta is 0
          await host.setAnimationGraphParameter(ROOT_CHAR_ENTITY_ID, "moving", false);
          // Step during and past the blend (30 steps = 0.5s)
          await host.step(30, 1 / 60);

          const qIdle = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          const zAfterIdle = qIdle.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID)!.position[2];

          // Character must not continue moving forward during idle
          assert.ok(
            Math.abs(zAfterIdle - zAfterWalk) < 0.05,
            `walk->idle must not accumulate locomotion: before=${zAfterWalk}, after=${zAfterIdle}`,
          );

          // Interruption test: start walk again, then trigger hurt mid-walk
          await host.setAnimationGraphParameter(ROOT_CHAR_ENTITY_ID, "moving", true);
          await host.step(10, 1 / 60);
          const zMidWalk = (await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] })).entities.find(
            (e) => e.entityId === ROOT_CHAR_ENTITY_ID,
          )!.position[2];

          // Interrupt with hurt trigger
          await host.triggerAnimationGraph(ROOT_CHAR_ENTITY_ID, "hurt");
          await host.step(20, 1 / 60);

          const zHurt = (await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] })).entities.find(
            (e) => e.entityId === ROOT_CHAR_ENTITY_ID,
          )!.position[2];

          // Hurt clears motion ownership -> character stops advancing
          assert.ok(
            Math.abs(zHurt - zMidWalk) < 0.05,
            `Hurt interruption must immediately stop motion ownership: mid=${zMidWalk}, hurt=${zHurt}`,
          );
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario D: Scene Restart & Frame Capture (Requirements 16, 17, 18, 19, 20)
    // -----------------------------------------------------------------------
    await t.test(
      "Requirements 16-20: Scene restart clears accumulators, captureFrame yields valid PNG, zero errors",
      async () => {
        const host = createHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createEmptyRootMotionProject(),
          initialRevision: 0,
          assets: rootMotionAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(EMPTY_SCENE_ID, 804);

          await host.configureRootMotion({
            entityId: ROOT_CHAR_ENTITY_ID,
            enabled: true,
            mode: "extract-xz",
            rootBoneName: "Hips",
          });

          await host.crossfadeAnimation(ROOT_CHAR_ENTITY_ID, "walk_root", 0);
          await host.step(30, 1 / 60);

          // Capture real frame during motion
          const capture = await host.captureFrame();
          assert.ok(capture.available && capture.base64, "Frame capture must be available with base64 data");
          const frameBytes = Buffer.from(capture.base64, "base64");
          assertValidPng(frameBytes, "Root motion movement frame");

          // Stop scene and restart
          await probe.stop();
          await probe.start(EMPTY_SCENE_ID, 805);

          const restarted = await host.query({ entityIds: [ROOT_CHAR_ENTITY_ID] });
          const char = restarted.entities.find((e) => e.entityId === ROOT_CHAR_ENTITY_ID);
          assert.ok(char);
          assert.equal(char.position[2], 0, "Restart must reset position to origin");

          // Read logs: zero animation or physics errors
          const logs = await host.readLogs();
          const errorLogs = logs.filter(
            (l) =>
              l.level === "error" &&
              (l.message.startsWith("animation.") || l.message.startsWith("physics.")),
          );
          assert.equal(errorLogs.length, 0, `Expected 0 animation/physics error logs, found: ${JSON.stringify(errorLogs)}`);
        } finally {
          await host.close();
        }
      },
    );
  },
);
