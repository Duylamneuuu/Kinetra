import assert from "node:assert/strict";
import test from "node:test";

import type {
  BlendSpace1DDefinition,
  BlendSpace2DDefinition,
} from "@kinetra/animation/blend-space.js";
import {
  createSyntheticAnimatedGlb,
  createSyntheticCharacterGlb,
} from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import {
  BlendSpacePlayback,
  ThreeSceneRuntime,
  resolveBlendSpaceClips,
  type AssetResolver,
} from "../src/index.js";

const sceneId = stableId("scene", "blend-space");
const heroId = stableId("entity", "blend_hero");
const otherId = stableId("entity", "blend_other");
const ASSET_HERO = "asset_blend_hero";
const ASSET_BOT = "asset_blend_bot";

function project(assetId: string, withSecond = false): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "blend-space"),
    name: "Blend space fixture",
    scenes: [
      {
        id: sceneId,
        name: "BlendSpace",
        entities: [
          {
            id: heroId,
            name: "Hero",
            components: { Transform: { position: [0, 0, 0] }, Model: { assetId } },
          },
          ...(withSecond
            ? [
                {
                  id: otherId,
                  name: "Other",
                  components: { Transform: { position: [3, 0, 0] }, Model: { assetId } },
                },
              ]
            : []),
        ],
      },
    ],
  };
}

/**
 * Hero with three clips of different lengths so phase sync is observable:
 * idle 1.0 s (x 0->1), walk 0.5 s (y 0->1), run 2.0 s (z 0->1).
 */
async function heroRuntime(withSecond = false): Promise<ThreeSceneRuntime> {
  const glb = await createSyntheticAnimatedGlb({
    meshName: "HeroMesh",
    nodeName: "AnimatedBoxNode",
    clipName: "idle",
    duration: 1.0,
    from: [0, 0, 0],
    to: [1, 0, 0],
  });
  const resolver: AssetResolver = { resolve: (id) => (id === ASSET_HERO ? glb : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(project(ASSET_HERO, withSecond), sceneId, {
    assetResolver: resolver,
  });
  const entities = withSecond ? [heroId, otherId] : [heroId];
  for (const entityId of entities) {
    runtime.registerAnimationClip(
      entityId,
      new THREE.AnimationClip("walk", 0.5, [
        new THREE.VectorKeyframeTrack("AnimatedBoxNode.position", [0, 0.5], [0, 0, 0, 0, 1, 0]),
      ]),
    );
    runtime.registerAnimationClip(
      entityId,
      new THREE.AnimationClip("run", 2.0, [
        new THREE.VectorKeyframeTrack("AnimatedBoxNode.position", [0, 2.0], [0, 0, 0, 0, 0, 1]),
      ]),
    );
  }
  return runtime;
}

const speed1D: BlendSpace1DDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "hero_speed",
  parameter: "speed",
  samples: [
    { clipId: "idle", position: 0 },
    { clipId: "walk", position: 1 },
    { clipId: "run", position: 3 },
  ],
};

const close = (actual: number | undefined, expected: number, eps = 1e-9, label = ""): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= eps, `${label} expected ${expected}, got ${actual}`);
};

function playback(runtime: ThreeSceneRuntime, entityId = heroId): BlendSpacePlayback {
  const pb = runtime.getAnimatorSession(entityId)?.blendSpace;
  assert.ok(pb, "blend space playback must be active");
  return pb;
}

test("playBlendSpace starts every sample action and publishes weights as structured state", async () => {
  const runtime = await heroRuntime();
  const result = runtime.playBlendSpace(heroId, speed1D, { input: { speed: 0.5 } });
  assert.equal(result.success, true, result.error);
  close(result.state?.weights.find((w) => w.clip === "idle")?.weight, 0.5);
  close(result.state?.weights.find((w) => w.clip === "walk")?.weight, 0.5);

  const meta = runtime.getModelMetadata(heroId)!;
  assert.equal(meta.animation?.blendSpace?.id, "hero_speed");
  assert.deepEqual(meta.animation?.blendSpace?.parameters, ["speed"]);
  assert.deepEqual(meta.animation?.blendSpace?.input, { speed: 0.5 });
  assert.equal(meta.animation?.playing, true);
  assert.ok(meta.animation?.actions?.every((a) => a.role === "blend"));
  assert.equal(meta.animation?.actions?.length, 2, "zero-weight run clip is not reported");

  const pb = playback(runtime);
  assert.deepEqual(pb.clipNames, ["idle", "walk", "run"]);
  for (const name of pb.clipNames) {
    assert.equal(pb.getAction(name)?.isRunning(), true, `${name} action runs so it stays phase-locked`);
  }
  close(pb.getAction("run")?.getEffectiveWeight(), 0);
  runtime.dispose();
});

test("phase sync: clips of different lengths advance through the same normalized phase", async () => {
  const runtime = await heroRuntime();
  assert.equal(runtime.playBlendSpace(heroId, speed1D, { input: { speed: 0.5 } }).success, true);
  const pb = playback(runtime);

  // cycle = 0.5 * 1.0 + 0.5 * 0.5 = 0.75 s
  close(pb.cycleDuration(), 0.75);
  close(pb.getAction("idle")?.getEffectiveTimeScale(), 1.0 / 0.75);
  close(pb.getAction("walk")?.getEffectiveTimeScale(), 0.5 / 0.75);

  runtime.updateAnimation(0.375); // half a cycle
  close(pb.state().phase, 0.5);
  close(pb.getAction("idle")?.time, 0.5);
  close(pb.getAction("walk")?.time, 0.25);
  close(pb.getAction("run")?.time, 1.0);

  // Long run with input changes every step: phases never drift apart.
  for (let i = 0; i < 600; i++) {
    const speed = 1.5 + 1.5 * Math.sin(i / 37);
    assert.equal(runtime.setBlendSpaceInput(heroId, { speed }).success, true);
    runtime.updateAnimation(1 / 60);
    const phase = pb.state().phase;
    assert.ok(phase >= 0 && phase < 1, `phase in [0,1) at step ${i}`);
    for (const name of pb.clipNames) {
      const action = pb.getAction(name)!;
      const normalized = action.time / action.getClip().duration;
      const diff = Math.abs(normalized - phase);
      assert.ok(Math.min(diff, 1 - diff) < 1e-9, `${name} phase ${normalized} vs ${phase} at step ${i}`);
    }
  }
  runtime.dispose();
});

test("a blend space at a sample position poses the model exactly like playing that clip", async () => {
  const glb = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = { resolve: (id) => (id === ASSET_BOT ? glb : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(project(ASSET_BOT, true), sceneId, {
    assetResolver: resolver,
  });

  const strafe: BlendSpace2DDefinition = {
    schemaVersion: 1,
    kind: "2d",
    id: "bot_locomotion",
    parameters: ["velocityX", "velocityZ"],
    samples: [
      { clipId: "idle", position: [0, 0] },
      { clipId: "walk", position: [0, 1] },
      { clipId: "attack", position: [1, 0] },
    ],
  };
  assert.equal(runtime.playBlendSpace(heroId, strafe, { input: { velocityX: 0, velocityZ: 1 } }).success, true);
  assert.equal(runtime.playAnimation(otherId, "walk"), true);
  for (let i = 0; i < 20; i++) runtime.updateAnimation(1 / 30);

  const poseOf = (entityId: string): number[] => {
    const nodes = runtime.getModelMetadata(entityId)?.nodes ?? [];
    return nodes.flatMap((n) => [...(n.rotation ?? []), ...n.position]);
  };
  const blended = poseOf(heroId);
  const direct = poseOf(otherId);
  assert.equal(blended.length, direct.length);
  assert.ok(blended.length > 0);
  for (let i = 0; i < blended.length; i++) {
    close(blended[i], direct[i]!, 1e-6, `pose component ${i}`);
  }

  // Moving off the sample changes the pose (the blend is real, not a single clip).
  assert.equal(runtime.setBlendSpaceInput(heroId, { velocityX: 0.5, velocityZ: 0.5 }).success, true);
  const weights = runtime.getBlendSpaceState(heroId)?.weights ?? [];
  assert.ok(weights.length >= 2, "off-sample input blends at least two clips");
  runtime.updateAnimation(1 / 30);
  runtime.updateAnimation(1 / 30);
  assert.equal(runtime.getModelMetadata(heroId)?.animation?.activeClip, weights[0]?.clip);
  runtime.dispose();
});

test("rejected blend spaces leave the current animation untouched", async () => {
  const runtime = await heroRuntime();
  assert.equal(runtime.playAnimation(heroId, "idle"), true);
  runtime.updateAnimation(0.25);
  const before = runtime.getAnimatorSession(heroId)?.activeAction;
  assert.ok(before);
  assert.ok(before.isRunning());

  const unknownClip = runtime.playBlendSpace(heroId, {
    ...speed1D,
    samples: [...speed1D.samples, { clipId: "sprint", position: 5 }],
  });
  assert.equal(unknownClip.success, false);
  assert.equal(unknownClip.code, "anim.blendSpace.clip.unknown");
  assert.match(unknownClip.error ?? "", /"sprint"/);

  const invalid = runtime.playBlendSpace(heroId, { ...speed1D, samples: [] });
  assert.equal(invalid.success, false);
  assert.equal(invalid.code, "anim.blendSpace.samples.empty");
  assert.ok(invalid.diagnostics && invalid.diagnostics.length > 0);

  const badInput = runtime.playBlendSpace(heroId, speed1D, { input: { velocity: 1 } });
  assert.equal(badInput.code, "anim.blendSpace.input.unknownParameter");
  const badSpeed = runtime.playBlendSpace(heroId, speed1D, { speed: Number.NaN });
  assert.equal(badSpeed.code, "anim.blendSpace.speed.invalid");

  const session = runtime.getAnimatorSession(heroId)!;
  assert.equal(session.blendSpace, undefined);
  assert.equal(session.activeAction, before);
  assert.equal(before.isRunning(), true);
  const meta = runtime.getModelMetadata(heroId)!;
  assert.equal(meta.animation?.activeClip, "idle");
  assert.equal(meta.animation?.blendSpace, undefined);

  const noModel = runtime.playBlendSpace(stableId("entity", "missing"), speed1D);
  assert.equal(noModel.code, "anim.blendSpace.entity.noModel");
  runtime.dispose();
});

test("setBlendSpaceInput is atomic and reports structured errors", async () => {
  const runtime = await heroRuntime();
  const notPlaying = runtime.setBlendSpaceInput(heroId, { speed: 1 });
  assert.equal(notPlaying.success, false);
  assert.equal(notPlaying.code, "anim.blendSpace.notPlaying");

  assert.equal(runtime.playBlendSpace(heroId, speed1D, { input: { speed: 2 } }).success, true);
  const snapshot = runtime.getBlendSpaceState(heroId);

  const unknown = runtime.setBlendSpaceInput(heroId, { speed: 1, sideways: 1 });
  assert.equal(unknown.code, "anim.blendSpace.input.unknownParameter");
  const nan = runtime.setBlendSpaceInput(heroId, { speed: Number.NaN });
  assert.equal(nan.code, "anim.blendSpace.input.invalid");
  const inf = runtime.setBlendSpaceInput(heroId, { speed: Number.POSITIVE_INFINITY });
  assert.equal(inf.code, "anim.blendSpace.input.invalid");
  const wrongType = runtime.setBlendSpaceInput(heroId, { speed: "fast" as unknown as number });
  assert.equal(wrongType.code, "anim.blendSpace.input.invalid");

  assert.deepEqual(runtime.getBlendSpaceState(heroId), snapshot, "failed updates change nothing");

  const ok = runtime.setBlendSpaceInput(heroId, { speed: 3 });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.state?.weights, [{ clip: "run", weight: 1 }]);
  runtime.dispose();
});

test("direct playback, stop, and a new blend space each cleanly replace the active blend space", async () => {
  const runtime = await heroRuntime();
  assert.equal(runtime.playBlendSpace(heroId, speed1D, { input: { speed: 2 } }).success, true);
  const first = playback(runtime);
  const walkAction = first.getAction("walk")!;
  const runAction = first.getAction("run")!;

  // Crossfade to a single clip takes over.
  assert.equal(runtime.crossfadeAnimation(heroId, "idle", 0.2), true);
  assert.equal(first.stopped, true);
  assert.equal(runtime.getAnimatorSession(heroId)?.blendSpace, undefined);
  assert.equal(walkAction.isRunning(), false);
  assert.equal(runAction.isRunning(), false);
  const meta = runtime.getModelMetadata(heroId)!;
  assert.equal(meta.animation?.blendSpace, undefined);
  assert.ok(meta.animation?.actions?.every((a) => a.role !== "blend"));
  runtime.updateAnimation(0.3);
  assert.deepEqual(meta.animation?.actions, [{ clip: "idle", weight: 1, role: "active" }]);

  // A blend space replaces the single clip (idle is also a sample: same action reused, not leaked).
  assert.equal(runtime.playBlendSpace(heroId, speed1D, { input: { speed: 0 } }).success, true);
  const second = playback(runtime);
  assert.equal(runtime.getAnimatorSession(heroId)?.activeAction, undefined);
  assert.equal(second.getAction("idle")?.isRunning(), true);
  close(second.getAction("idle")?.getEffectiveWeight(), 1);

  // Replacing a blend space with another stops the first one.
  assert.equal(runtime.playBlendSpace(heroId, { ...speed1D, id: "hero_speed_v2" }, { input: { speed: 1 } }).success, true);
  assert.equal(second.stopped, true);
  assert.equal(runtime.getBlendSpaceState(heroId)?.id, "hero_speed_v2");

  runtime.stopAnimation(heroId);
  assert.equal(runtime.getBlendSpaceState(heroId), undefined);
  assert.equal(meta.animation?.blendSpace, undefined);
  assert.equal(meta.animation?.playing, false);
  runtime.dispose();
});

test("blend spaces on two entities sharing an asset are independent", async () => {
  const runtime = await heroRuntime(true);
  assert.equal(runtime.playBlendSpace(heroId, speed1D, { input: { speed: 0.5 } }).success, true);
  assert.equal(runtime.playBlendSpace(otherId, speed1D, { input: { speed: 3 } }).success, true);
  runtime.updateAnimation(0.2);
  assert.notDeepEqual(runtime.getBlendSpaceState(heroId)?.weights, runtime.getBlendSpaceState(otherId)?.weights);
  runtime.stopAnimation(heroId);
  assert.equal(runtime.getBlendSpaceState(heroId), undefined);
  assert.equal(runtime.getBlendSpaceState(otherId)?.dominantClip, "run");
  runtime.dispose();
});

test("root-motion entities refuse blend-space playback with a structured code", async () => {
  const runtime = await heroRuntime();
  const configured = runtime.configureRootMotion(heroId, { enabled: true, rootBoneName: "AnimatedBoxNode" });
  assert.equal(configured.success, true, configured.error);
  const result = runtime.playBlendSpace(heroId, speed1D);
  assert.equal(result.success, false);
  assert.equal(result.code, "anim.blendSpace.rootMotionUnsupported");
  runtime.dispose();
});

test("disposed runtimes reject blend-space calls and dispose stops active playback", async () => {
  const runtime = await heroRuntime();
  assert.equal(runtime.playBlendSpace(heroId, speed1D).success, true);
  const pb = playback(runtime);
  runtime.dispose();
  assert.equal(pb.stopped, true);
  assert.equal(runtime.playBlendSpace(heroId, speed1D).code, "runtime.disposed");
  assert.equal(runtime.setBlendSpaceInput(heroId, { speed: 1 }).code, "runtime.disposed");
  assert.equal(runtime.getBlendSpaceState(heroId), undefined);
});

test("BlendSpacePlayback: create validates without touching the mixer; stop is idempotent", () => {
  const root = new THREE.Object3D();
  root.name = "Root";
  const mixer = new THREE.AnimationMixer(root);
  const clip = (name: string, duration: number): THREE.AnimationClip =>
    new THREE.AnimationClip(name, duration, [
      new THREE.NumberKeyframeTrack("Root.position[x]", [0, Math.max(duration, 0.001)], [0, 1]),
    ]);
  const clips = [clip("idle", 1), clip("walk_retargeted", 0.8), clip("broken", 0)];

  // Retargeted variant resolves transparently.
  const resolved = resolveBlendSpaceClips(
    { schemaVersion: 1, kind: "1d", id: "s", parameter: "speed", samples: [{ clipId: "idle", position: 0 }, { clipId: "walk", position: 1 }] },
    clips,
  );
  assert.equal(resolved.success, true);
  assert.deepEqual(
    resolved.success ? resolved.bindings.map((b) => b.resolvedClipName) : [],
    ["idle", "walk_retargeted"],
  );

  const zero = BlendSpacePlayback.create(
    { schemaVersion: 1, kind: "1d", id: "z", parameter: "speed", samples: [{ clipId: "broken", position: 0 }] },
    mixer,
    clips,
  );
  assert.equal(zero.success, false);
  assert.equal(zero.success ? "" : zero.code, "anim.blendSpace.clip.zeroDuration");

  const created = BlendSpacePlayback.create(
    { schemaVersion: 1, kind: "1d", id: "s", parameter: "speed", samples: [{ clipId: "idle", position: 0 }, { clipId: "walk", position: 1 }] },
    mixer,
    clips,
    { input: { speed: 0.25 }, speed: 2 },
  );
  assert.ok(created.success);
  const pb = created.playback;
  assert.equal(pb.started, false);
  assert.equal(pb.getAction("idle"), undefined, "create does not start actions");
  pb.begin();
  pb.begin();
  assert.equal(pb.started, true);
  close(pb.getAction("idle")?.getEffectiveWeight(), 0.75);
  assert.equal(pb.setSpeed(Number.NaN), false);
  assert.equal(pb.setSpeed(0), true);
  pb.prepareStep(1);
  close(pb.state().phase, 0, 1e-12, "zero speed freezes the phase");
  assert.equal(pb.setSpeed(-1), true);
  pb.prepareStep(0.2);
  assert.ok(pb.state().phase > 0.5, "negative speed wraps backwards into [0,1)");

  const idle = pb.getAction("idle")!;
  pb.stop();
  pb.stop();
  assert.equal(pb.stopped, true);
  assert.equal(idle.isRunning(), false);
  assert.equal(pb.setInput({ speed: 1 }).success, false);
  assert.equal(pb.setSpeed(1), false);
});

test("live asset reload restores the active blend space with its input on the new instance", async () => {
  let revision = 1;
  const glb = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = {
    resolve: (id) => (id === ASSET_BOT ? glb : undefined),
    getFingerprint: (id) => (id === ASSET_BOT ? `fp_bot_v${revision}` : undefined),
  };
  const runtime = await ThreeSceneRuntime.instantiateAsync(project(ASSET_BOT), sceneId, { assetResolver: resolver });
  const locomotion: BlendSpace1DDefinition = {
    schemaVersion: 1,
    kind: "1d",
    id: "bot_speed",
    parameter: "speed",
    samples: [
      { clipId: "idle", position: 0 },
      { clipId: "walk", position: 1 },
    ],
  };
  assert.equal(runtime.playBlendSpace(heroId, locomotion, { input: { speed: 0.3 }, speed: 1.25 }).success, true);
  const before = playback(runtime);

  revision = 2;
  const reload = await runtime.reloadAsset(ASSET_BOT, resolver);
  assert.equal(reload.success, true, reload.error);
  assert.deepEqual(reload.affectedEntities, [heroId]);

  assert.equal(before.stopped, true, "old playback is stopped with the old mixer");
  const after = playback(runtime);
  assert.notEqual(after, before);
  const state = runtime.getBlendSpaceState(heroId);
  assert.equal(state?.id, "bot_speed");
  assert.deepEqual(state?.input, { speed: 0.3 });
  assert.equal(state?.speed, 1.25);
  assert.equal(runtime.getModelMetadata(heroId)?.animation?.blendSpace?.id, "bot_speed");
  runtime.updateAnimation(0.1);
  assert.ok((runtime.getBlendSpaceState(heroId)?.phase ?? 0) > 0);
  runtime.dispose();
});

test("two samples that resolve to the same clip are rejected instead of sharing one action", () => {
  // "walk" has no clip of its own and falls back to "walk_retargeted", which a
  // second sample also names. Both samples would drive the single mixer action
  // for walk_retargeted, so one sample's weight silently overwrote the other's
  // and the published weights no longer matched the pose.
  const root = new THREE.Object3D();
  root.name = "Root";
  const mixer = new THREE.AnimationMixer(root);
  const clip = (name: string, duration: number): THREE.AnimationClip =>
    new THREE.AnimationClip(name, duration, [
      new THREE.NumberKeyframeTrack("Root.position[x]", [0, duration], [0, 1]),
    ]);
  const clips = [clip("idle", 1), clip("walk_retargeted", 0.8)];
  const space: BlendSpace1DDefinition = {
    schemaVersion: 1,
    kind: "1d",
    id: "dup",
    parameter: "speed",
    samples: [
      { clipId: "idle", position: 0 },
      { clipId: "walk", position: 1 },
      { clipId: "walk_retargeted", position: 2 },
    ],
  };
  const resolved = resolveBlendSpaceClips(space, clips);
  assert.equal(resolved.success, false);
  assert.equal(resolved.success ? "" : resolved.code, "anim.blendSpace.clip.duplicate");
  assert.match(resolved.success ? "" : resolved.error, /walk_retargeted/);

  const created = BlendSpacePlayback.create(space, mixer, clips, { input: { speed: 1.5 } });
  assert.equal(created.success, false);
  assert.equal(created.success ? "" : created.code, "anim.blendSpace.clip.duplicate");
});
