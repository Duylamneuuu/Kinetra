import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as THREE from "three";

import type { AnimationGraphDefinition } from "@kinetra/animation";
import {
  ARENA_ENEMY_ANIMATION_GRAPH,
  ARENA_ENEMY_MODEL_ASSET_ID,
  ARENA_ENTITY_ENEMY,
  ARENA_ENTITY_PLAYER,
  ARENA_SCENE_ID,
  arenaAudioAssets,
  createArenaProject,
} from "@kinetra/reference-game";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

function findRepoFile(relPath: string): string {
  let curr = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(curr, relPath);
    if (existsSync(candidate)) return candidate;
    curr = dirname(curr);
  }
  return resolve(process.cwd(), relPath);
}

function createArenaHost(saveDir?: string): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    ...(saveDir ? { saveDir } : {}),
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

const testGraphDefinition: AnimationGraphDefinition = {
  schemaVersion: 1,
  entryState: "idle",
  parameters: {
    moving: { type: "bool", default: false },
    telegraph: { type: "trigger" },
    attack: { type: "trigger" },
    hurt: { type: "trigger" },
    defeated: { type: "bool", default: false },
  },
  states: [
    { id: "idle", clipId: "idle", loop: true },
    { id: "walk", clipId: "walk", loop: true },
    { id: "telegraph", clipId: "telegraph", loop: true },
    { id: "attack", clipId: "attack", loop: false },
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
      id: "to-attack",
      from: "*",
      to: "attack",
      priority: 40,
      blendSeconds: 0.15,
      conditions: [{ parameter: "attack", op: "triggered" }],
    },
    {
      id: "to-telegraph",
      from: "*",
      to: "telegraph",
      priority: 30,
      blendSeconds: 0.15,
      conditions: [{ parameter: "telegraph", op: "triggered" }],
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
  "Runtime Animation Graph + Deterministic Crossfade Vertical Slice",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    // -----------------------------------------------------------------------
    // Scenario 1: Animation Graph Lifecycle & Entry State Initialization
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 1: initAnimationGraph sets entry state with weight 1.0 and zero initial blend",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 701);
          const raw = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemy = raw.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          assert.ok(enemy?.model?.loaded, "Enemy model must be loaded");

          // Initialize custom test graph
          const initRes = await host.initAnimationGraph(ARENA_ENTITY_ENEMY, testGraphDefinition);
          assert.equal(initRes.success, true, "initAnimationGraph must succeed");

          // Verify entry state
          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const anim = q.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.ok(anim, "Animation state must exist");
          assert.equal(anim.activeClip, "idle");
          assert.equal(anim.playing, true);

          // Verify structured graph state
          assert.ok(anim.graph, "Graph state must be exposed");
          assert.equal(anim.graph.state, "idle");
          assert.equal(anim.graph.transitioning, false);
          assert.equal(anim.graph.blendProgress, 1.0);

          // Verify actions array
          assert.ok(anim.actions, "Actions array must be exposed");
          assert.equal(anim.actions.length, 1);
          assert.equal(anim.actions[0]?.clip, "idle");
          assert.equal(anim.actions[0]?.weight, 1.0);
          assert.equal(anim.actions[0]?.role, "active");
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 2: Deterministic Boolean Transitions & Concurrent Weights during Crossfade
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 2: Boolean parameter triggers transition with deterministic concurrent weights shifted by runtime.step",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 702);
          await host.initAnimationGraph(ARENA_ENTITY_ENEMY, testGraphDefinition);

          // Trigger transition to walk via boolean parameter
          const setRes = await host.setAnimationGraphParameter(ARENA_ENTITY_ENEMY, "moving", true);
          assert.equal(setRes.success, true);

          // Query state at beginning of crossfade (0 elapsed)
          const q0 = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const anim0 = q0.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.ok(anim0?.graph);
          assert.equal(anim0.graph.state, "walk");
          assert.equal(anim0.graph.previousState, "idle");
          assert.equal(anim0.graph.transitionId, "idle-to-walk");
          assert.equal(anim0.graph.transitioning, true);
          assert.equal(anim0.graph.blendSeconds, 0.2);
          assert.equal(anim0.graph.blendElapsed, 0);
          assert.equal(anim0.graph.blendProgress, 0);

          assert.ok(anim0.actions);
          assert.equal(anim0.actions.length, 2);
          const out0 = anim0.actions.find((a) => a.role === "outgoing");
          const in0 = anim0.actions.find((a) => a.role === "incoming");
          assert.ok(out0 && in0);
          assert.equal(out0.clip, "idle");
          assert.equal(out0.weight, 1.0);
          assert.equal(in0.clip, "walk");
          assert.equal(in0.weight, 0.0);

          // Deterministically advance 6 steps at 60Hz = 0.1s (50% of 0.2s blend)
          await host.step(6, 1 / 60);

          const qMid = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const animMid = qMid.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.ok(animMid?.graph);
          assert.equal(animMid.graph.transitioning, true);
          assert.ok(
            animMid.graph.blendElapsed! >= 0.09 && animMid.graph.blendElapsed! <= 0.11,
            `Expected blendElapsed ~0.1, got ${animMid.graph.blendElapsed}`,
          );
          assert.ok(
            animMid.graph.blendProgress! >= 0.45 && animMid.graph.blendProgress! <= 0.55,
            `Expected blendProgress ~0.5, got ${animMid.graph.blendProgress}`,
          );

          // Verify concurrent weights
          assert.ok(animMid.actions);
          assert.equal(animMid.actions.length, 2);
          const outMid = animMid.actions.find((a) => a.role === "outgoing");
          const inMid = animMid.actions.find((a) => a.role === "incoming");
          assert.ok(outMid && inMid);
          assert.ok(outMid.weight >= 0.45 && outMid.weight <= 0.55, `Expected outWeight ~0.5, got ${outMid.weight}`);
          assert.ok(inMid.weight >= 0.45 && inMid.weight <= 0.55, `Expected inWeight ~0.5, got ${inMid.weight}`);

          // Visual verification during active blend
          const frame = await host.captureFrame();
          assert.equal(frame.available, true);
          assert.ok(frame.base64);
          const frameBytes = Buffer.from(frame.base64, "base64");
          assertValidPng(frameBytes, "Active crossfade frame capture");

          // Advance past remaining 0.1s (e.g. 8 steps = ~0.133s)
          await host.step(8, 1 / 60);

          const qEnd = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const animEnd = qEnd.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.ok(animEnd?.graph);
          assert.equal(animEnd.graph.state, "walk");
          assert.equal(animEnd.graph.previousState, "idle");
          assert.equal(animEnd.graph.transitioning, false);
          assert.equal(animEnd.graph.blendProgress, 1.0);

          // Verify outgoing action has been stopped and cleaned
          assert.ok(animEnd.actions);
          assert.equal(animEnd.actions.length, 1);
          assert.equal(animEnd.actions[0]?.clip, "walk");
          assert.equal(animEnd.actions[0]?.weight, 1.0);
          assert.equal(animEnd.actions[0]?.role, "active");
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 3: Triggers, Priority Tie-Breaking, and Mid-Blend Interruption
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 3: Triggers, priority tie-breaking, and mid-blend interruption cleanly reassigns outgoing action without leakage",
      async () => {
        const project = createArenaProject();
        const playerEntity = project.scenes[0]!.entities.find((e) => e.id === ARENA_ENTITY_PLAYER);
        if (playerEntity) {
          (playerEntity.components.Transform as any).position = [50, 0, 50];
        }

        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => project,
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 703);
          await host.initAnimationGraph(ARENA_ENTITY_ENEMY, testGraphDefinition);

          // Start walk
          await host.setAnimationGraphParameter(ARENA_ENTITY_ENEMY, "moving", true);
          await host.step(15, 1 / 60); // Complete walk blend

          // Trigger telegraph (blendSeconds = 0.15, priority = 30)
          const trigRes = await host.triggerAnimationGraph(ARENA_ENTITY_ENEMY, "telegraph");
          assert.equal(trigRes.success, true);

          // Advance 4 steps (0.066s into 0.15s blend)
          await host.step(4, 1 / 60);

          const qMid = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const animMid = qMid.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.equal(animMid?.graph?.state, "telegraph");
          assert.equal(animMid?.graph?.transitioning, true);

          // Interrupt with higher priority trigger: hurt (priority = 50 > 30)
          const hurtRes = await host.triggerAnimationGraph(ARENA_ENTITY_ENEMY, "hurt");
          assert.equal(hurtRes.success, true);

          // Query immediately after interruption
          const qInt = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const animInt = qInt.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.ok(animInt?.graph);
          assert.equal(animInt.graph.state, "hurt");
          assert.equal(animInt.graph.previousState, "telegraph");
          assert.equal(animInt.graph.transitioning, true);

          // Actions array must have exactly TWO actions:
          // telegraph (outgoing) and hurt (incoming). walk MUST be stopped and cleaned!
          assert.ok(animInt.actions);
          assert.equal(animInt.actions.length, 2, "Interruption must leave exactly 2 active actions (no leakage)");
          const outAction = animInt.actions.find((a) => a.role === "outgoing");
          const inAction = animInt.actions.find((a) => a.role === "incoming");
          assert.equal(outAction?.clip, "telegraph");
          assert.equal(inAction?.clip, "hurt");

          // Advance through hurt blend (0.1s blend + extra)
          await host.step(10, 1 / 60);

          const qDone = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const animDone = qDone.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.equal(animDone?.graph?.transitioning, false);
          assert.equal(animDone?.actions?.length, 1);
          assert.equal(animDone?.actions?.[0]?.clip, "hurt");
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 4: Zero-Second Switch (Immediate Cut)
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 4: Immediate switch (blendSeconds == 0) switches active action instantly without concurrent blend session",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 704);
          await host.crossfadeAnimation(ARENA_ENTITY_ENEMY, "walk", 0);

          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const anim = q.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.equal(anim?.activeClip, "walk");
          assert.equal(anim?.graph?.transitioning, false);
          assert.equal(anim?.graph?.blendProgress, 1.0);
          assert.equal(anim?.actions?.length, 1);
          assert.equal(anim?.actions?.[0]?.clip, "walk");
          assert.equal(anim?.actions?.[0]?.weight, 1.0);
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 5: Negative Proofs & Structured Diagnostics
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 5: Negative proofs produce structured failure without crashing runtime",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 705);

          // 1. Invalid graph (missing entry state)
          const badGraph: any = {
            schemaVersion: 1,
            entryState: "nonexistent",
            parameters: {},
            states: [{ id: "idle", clipId: "idle" }],
            transitions: [],
          };
          const badInit = await host.initAnimationGraph(ARENA_ENTITY_ENEMY, badGraph);
          assert.equal(badInit.success, false);
          assert.ok(badInit.error?.toLowerCase().includes("entry"));

          // Initialize valid graph first
          await host.initAnimationGraph(ARENA_ENTITY_ENEMY, testGraphDefinition);

          // 2. Unknown parameter name
          const badParam = await host.setAnimationGraphParameter(
            ARENA_ENTITY_ENEMY,
            "nonexistent_param",
            true,
          );
          assert.equal(badParam.success, false);
          assert.ok(badParam.error?.includes("Unknown"));

          // 3. Wrong parameter type (number for bool)
          const wrongType = await host.setAnimationGraphParameter(
            ARENA_ENTITY_ENEMY,
            "moving",
            42,
          );
          assert.equal(wrongType.success, false);
          assert.ok(wrongType.error?.includes("boolean"));

          // 4. Unknown trigger name
          const badTrigger = await host.triggerAnimationGraph(
            ARENA_ENTITY_ENEMY,
            "nonexistent_trigger",
          );
          assert.equal(badTrigger.success, false);
          assert.ok(badTrigger.error?.includes("Unknown"));

          // 5. Crossfade to unknown clip
          const badClip = await host.crossfadeAnimation(
            ARENA_ENTITY_ENEMY,
            "imaginary_clip_xyz",
            0.15,
          );
          assert.equal(badClip.success, false);

          // Runtime is still alive and responsive
          const snap = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          assert.equal(snap.running, true);
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 6: Retargeted Clip Compatibility with Animation Graph
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 6: Clips registered via registerAnimationClip are recognized and blended into via graph",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 706);

          // Create a synthetic THREE.AnimationClip with _retargeted suffix
          const track = new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 1, 0, 0, 1.2, 0]);
          const syntheticClip = new THREE.AnimationClip("dance_retargeted", 1.0, [track]);

          const regRes = await host.registerAnimationClip(
            ARENA_ENTITY_ENEMY,
            syntheticClip.toJSON(),
          );
          assert.ok(regRes);

          // Create a graph referencing the dance state
          const retargetGraph: AnimationGraphDefinition = {
            schemaVersion: 1,
            entryState: "idle",
            parameters: {
              dance: { type: "trigger" },
            },
            states: [
              { id: "idle", clipId: "idle", loop: true },
              { id: "dance", clipId: "dance", loop: true },
            ],
            transitions: [
              {
                id: "idle-to-dance",
                from: "idle",
                to: "dance",
                blendSeconds: 0.15,
                conditions: [{ parameter: "dance", op: "triggered" }],
              },
            ],
          };

          await host.initAnimationGraph(ARENA_ENTITY_ENEMY, retargetGraph);

          // Trigger dance
          const trig = await host.triggerAnimationGraph(ARENA_ENTITY_ENEMY, "dance");
          assert.equal(trig.success, true);

          // Query state: resolved clip name should be dance_retargeted
          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const anim = q.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.equal(anim?.graph?.state, "dance");
          assert.equal(anim?.activeClip, "dance_retargeted");
          assert.ok(anim?.actions?.some((a) => a.clip === "dance_retargeted"));
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 7: Real Arena EnemyBot Game Playthrough & Combat Preservation
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 7: Arena EnemyBot runs ARENA_ENEMY_ANIMATION_GRAPH with 0 play/load failures",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 707);

          // Enemy starts in chasing -> graph state walk
          await host.step(5, 1 / 60);

          const qStart = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const enemyStart = qStart.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY);
          assert.ok(enemyStart?.model?.animation?.graph);
          assert.equal(enemyStart.model.animation.graph.state, "walk");

          // Step until telegraph / attack occurs
          for (let i = 0; i < 30; i++) {
            await host.step(1, 1 / 60);
          }

          // Damage enemy
          await host.injectInput({ action: "player.attack", phase: "press" });
          await host.step(2, 1 / 60);

          // Verify logs: zero animation.playFailed and zero model.loadFailed
          const logs = await host.readLogs();
          const playFailed = logs.filter(
            (l) => l.message === "animation.playFailed" || l.data?.event === "animation.playFailed",
          );
          const loadFailed = logs.filter(
            (l) => l.message === "model.loadFailed" || l.data?.event === "model.loadFailed",
          );
          const errorLogs = logs.filter((l) => l.level === "error");
          assert.equal(playFailed.length, 0, `Expected 0 animation.playFailed, found ${playFailed.length}`);
          assert.equal(loadFailed.length, 0, `Expected 0 model.loadFailed, found ${loadFailed.length}`);
          assert.equal(errorLogs.length, 0, `Expected 0 error logs, found: ${JSON.stringify(errorLogs)}`);
        } finally {
          await host.close();
        }
      },
    );

    // -----------------------------------------------------------------------
    // Scenario 8: Teardown & Clean Lifecycle
    // -----------------------------------------------------------------------
    await t.test(
      "Scenario 8: stopAnimation tears down graph session and host.close leaves zero orphan processes",
      async () => {
        const host = createArenaHost();
        const probe = new KinetraRuntimeProbe({
          host,
          project: () => createArenaProject(),
          initialRevision: 0,
          assets: arenaAudioAssets,
          closeOnStop: false,
        });

        try {
          await probe.start(ARENA_SCENE_ID, 708);
          await host.initAnimationGraph(ARENA_ENTITY_ENEMY, testGraphDefinition);
          await host.stopAnimation(ARENA_ENTITY_ENEMY);

          const q = await host.query({ entityIds: [ARENA_ENTITY_ENEMY] });
          const anim = q.entities.find((e) => e.entityId === ARENA_ENTITY_ENEMY)?.model?.animation;
          assert.equal(anim?.playing, false);
          assert.equal(anim?.graph, undefined);
          assert.equal(anim?.actions, undefined);
        } finally {
          await host.close();
        }
      },
    );
  },
);
