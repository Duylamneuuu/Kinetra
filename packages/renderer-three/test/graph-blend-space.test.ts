import assert from "node:assert/strict";
import test from "node:test";

import type { AnimationGraphDefinition } from "@kinetra/animation/graph.js";
import type { BlendSpaceDefinition } from "@kinetra/animation/blend-space.js";
import { createSyntheticAnimatedGlb, createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import { ThreeSceneRuntime, type AssetResolver } from "../src/index.js";

const sceneId = stableId("scene", "graph-blend-space");
const heroId = stableId("entity", "graph_hero");
const ASSET_HERO = "asset_graph_hero";
const ASSET_BOT = "asset_graph_bot";

function project(assetId: string): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "graph-blend-space"),
    name: "Graph blend space fixture",
    scenes: [
      {
        id: sceneId,
        name: "GraphBlendSpace",
        entities: [
          {
            id: heroId,
            name: "Hero",
            components: { Transform: { position: [0, 0, 0] }, Model: { assetId } },
          },
        ],
      },
    ],
  };
}

function track(durationSeconds: number, axis: 0 | 1 | 2): THREE.VectorKeyframeTrack {
  const to = [0, 0, 0];
  to[axis] = 1;
  return new THREE.VectorKeyframeTrack("AnimatedBoxNode.position", [0, durationSeconds], [0, 0, 0, ...to]);
}

/** idle is the synthetic clip (1 s); the rest are registered with distinct lengths. */
async function heroRuntime(): Promise<ThreeSceneRuntime> {
  const glb = await createSyntheticAnimatedGlb({
    meshName: "HeroMesh",
    nodeName: "AnimatedBoxNode",
    clipName: "idle",
    duration: 1.0,
    from: [0, 0, 0],
    to: [1, 0, 0],
  });
  const resolver: AssetResolver = { resolve: (id) => (id === ASSET_HERO ? glb : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(project(ASSET_HERO), sceneId, { assetResolver: resolver });
  const extra: Array<[string, number, 0 | 1 | 2]> = [
    ["stand", 1.0, 0],
    ["walk", 0.5, 1],
    ["run", 2.0, 2],
    ["crouch_idle", 1.0, 0],
    ["crouch_walk", 1.5, 1],
    ["jump", 0.8, 2],
  ];
  for (const [name, duration, axis] of extra) {
    runtime.registerAnimationClip(heroId, new THREE.AnimationClip(name, duration, [track(duration, axis)]));
  }
  return runtime;
}

const locomotion: BlendSpaceDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "locomotion",
  parameter: "speed",
  samples: [
    { clipId: "walk", position: 1 },
    { clipId: "run", position: 3 },
  ],
};

const crouchLocomotion: BlendSpaceDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "crouch_locomotion",
  parameter: "crouchSpeed",
  samples: [
    { clipId: "crouch_idle", position: 0 },
    { clipId: "crouch_walk", position: 1 },
  ],
};

function graph(): AnimationGraphDefinition {
  return {
    schemaVersion: 1,
    entryState: "stand",
    parameters: {
      speed: { type: "number", default: 0 },
      crouchSpeed: { type: "number", default: 0 },
      crouching: { type: "bool", default: false },
      jump: { type: "trigger" },
    },
    blendSpaces: [locomotion, crouchLocomotion],
    states: [
      { id: "stand", clipId: "stand" },
      { id: "move", blendSpaceId: "locomotion", speed: 1.25 },
      { id: "crouch", blendSpaceId: "crouch_locomotion" },
      { id: "leap", clipId: "jump", loop: false },
    ],
    transitions: [
      { id: "start", from: "stand", to: "move", conditions: [{ parameter: "speed", op: ">", value: 0.1 }], blendSeconds: 0.2 },
      { id: "stop", from: "move", to: "stand", conditions: [{ parameter: "speed", op: "<=", value: 0.1 }], blendSeconds: 0.3 },
      { id: "duck", from: "move", to: "crouch", conditions: [{ parameter: "crouching", op: "==", value: true }], blendSeconds: 0.4 },
      { id: "to-leap", from: "*", to: "leap", conditions: [{ parameter: "jump", op: "triggered" }], blendSeconds: 0.1 },
    ],
  };
}

const close = (actual: number | undefined, expected: number, eps = 1e-9, label = ""): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= eps, `${label} expected ${expected}, got ${actual}`);
};

function sessionOf(runtime: ThreeSceneRuntime) {
  const session = runtime.getAnimatorSession(heroId);
  assert.ok(session, "animator session exists");
  return session;
}

function animation(runtime: ThreeSceneRuntime) {
  const state = runtime.getModelMetadata(heroId)?.animation;
  assert.ok(state, "animation metadata exists");
  return state;
}

function weightsByRole(runtime: ThreeSceneRuntime, role: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const action of animation(runtime).actions ?? []) {
    if (action.role === role) result[action.clip] = (result[action.clip] ?? 0) + action.weight;
  }
  return result;
}

function total(weights: Record<string, number>): number {
  return Object.values(weights).reduce((sum, w) => sum + w, 0);
}

function setSpeed(runtime: ThreeSceneRuntime, value: number): void {
  const result = runtime.setAnimationGraphParameter(heroId, "speed", value);
  assert.equal(result.success, true, result.error);
}

test("clip state -> blend-space state crossfades with observable blendProgress and group weights", async () => {
  const runtime = await heroRuntime();
  assert.equal(runtime.initAnimationGraph(heroId, graph()).success, true);
  assert.equal(animation(runtime).graph?.state, "stand");
  assert.equal(runtime.getBlendSpaceState(heroId), undefined);

  const change = runtime.setAnimationGraphParameter(heroId, "speed", 2);
  assert.equal(change.success, true, change.error);
  assert.equal(change.transition?.to, "move");

  // Transition just started: stand still plays, blend space is armed at weight 0.
  assert.equal(animation(runtime).graph?.state, "move");
  assert.equal(animation(runtime).graph?.previousState, "stand");
  assert.equal(animation(runtime).graph?.transitioning, true);
  assert.equal(animation(runtime).graph?.blendProgress, 0);
  const space = sessionOf(runtime).blendSpace!;
  assert.equal(space.definition.id, "locomotion");
  assert.equal(space.groupWeight, 0);
  assert.equal(space.speed, 1.25, "state speed becomes the blend-space speed");
  close(total(weightsByRole(runtime, "outgoing")), 1);
  close(total(weightsByRole(runtime, "incoming")), 0);

  // Halfway through the 0.2 s fade.
  runtime.updateAnimation(0.1);
  assert.equal(animation(runtime).graph?.transitioning, true);
  close(animation(runtime).graph?.blendProgress, 0.5, 1e-9, "blendProgress");
  assert.equal(space.groupWeight, 0.5);
  close(weightsByRole(runtime, "outgoing").stand, 0.5);
  const incoming = weightsByRole(runtime, "incoming");
  close(total(incoming), 0.5);
  close(incoming.walk, 0.25);
  close(incoming.run, 0.25);
  // The mixer actions carry the same weights the metadata reports.
  close(space.getAction("walk")?.getEffectiveWeight(), 0.25);
  close(space.getAction("run")?.getEffectiveWeight(), 0.25);
  close(sessionOf(runtime).outgoingAction?.getEffectiveWeight(), 0.5);

  // Fade complete.
  runtime.updateAnimation(0.15);
  const meta = animation(runtime);
  assert.equal(meta.graph?.transitioning, false);
  assert.equal(meta.graph?.blendProgress, 1);
  assert.equal(space.groupWeight, 1);
  assert.equal(sessionOf(runtime).outgoingAction, undefined);
  assert.equal(meta.blendSpace?.id, "locomotion");
  assert.ok(meta.actions?.every((a) => a.role === "blend"));
  close(total(weightsByRole(runtime, "blend")), 1);
  runtime.dispose();
});

test("a graph number parameter drives the blend-space weights on every step", async () => {
  const runtime = await heroRuntime();
  runtime.initAnimationGraph(heroId, graph());
  setSpeed(runtime, 1);
  runtime.updateAnimation(0.25); // fade done
  close(runtime.getBlendSpaceState(heroId)?.weights.find((w) => w.clip === "walk")?.weight, 1);

  // The parameter changes: the very next read already reflects it ...
  setSpeed(runtime, 2);
  assert.deepEqual(runtime.getBlendSpaceState(heroId)?.input, { speed: 2 });
  close(runtime.getBlendSpaceState(heroId)?.weights.find((w) => w.clip === "run")?.weight, 0.5);
  // ... and a step keeps the pose in sync with it.
  runtime.updateAnimation(0.05);
  const state = runtime.getBlendSpaceState(heroId)!;
  assert.deepEqual(state.input, { speed: 2 });
  assert.equal(state.dominantClip === "walk" || state.dominantClip === "run", true);

  setSpeed(runtime, 3);
  assert.deepEqual(runtime.getBlendSpaceState(heroId)?.weights.map((w) => w.clip), ["run"]);
  runtime.dispose();
});

test("blend-space state -> clip state fades the whole space out while the parameter keeps driving it", async () => {
  const runtime = await heroRuntime();
  runtime.initAnimationGraph(heroId, graph());
  setSpeed(runtime, 2);
  runtime.updateAnimation(0.25);
  const space = sessionOf(runtime).blendSpace!;

  const stop = runtime.setAnimationGraphParameter(heroId, "speed", 0);
  assert.equal(stop.transition?.transitionId, "stop");
  assert.equal(stop.transition?.blendSeconds, 0.3);
  assert.equal(sessionOf(runtime).blendSpace, undefined, "no incoming blend space");
  assert.equal(sessionOf(runtime).outgoingBlendSpace, space);
  assert.equal(animation(runtime).blendSpace, undefined);
  assert.equal(animation(runtime).graph?.state, "stand");
  assert.equal(animation(runtime).graph?.transitioning, true);
  close(total(weightsByRole(runtime, "outgoing")), 1);
  close(weightsByRole(runtime, "incoming").stand, 0);

  runtime.updateAnimation(0.15); // progress 0.5
  close(animation(runtime).graph?.blendProgress, 0.5);
  close(space.groupWeight, 0.5);
  close(total(weightsByRole(runtime, "outgoing")), 0.5);
  close(weightsByRole(runtime, "incoming").stand, 0.5);

  // The fading blend space still follows the parameter.
  setSpeed(runtime, 0.05);
  assert.deepEqual(space.state().input, { speed: 0.05 });
  runtime.updateAnimation(0.05);
  assert.deepEqual(space.state().input, { speed: 0.05 });

  runtime.updateAnimation(0.2); // complete
  assert.equal(animation(runtime).graph?.transitioning, false);
  assert.equal(sessionOf(runtime).outgoingBlendSpace, undefined);
  assert.equal(space.stopped, true);
  for (const clip of ["walk", "run"]) {
    assert.equal(space.getAction(clip), undefined, `${clip} action released`);
  }
  assert.deepEqual(animation(runtime).actions, [{ clip: "stand", weight: 1, role: "active" }]);
  runtime.dispose();
});

test("blend-space state -> blend-space state crossfades two groups that sum to one", async () => {
  const runtime = await heroRuntime();
  runtime.initAnimationGraph(heroId, graph());
  setSpeed(runtime, 2);
  runtime.updateAnimation(0.25);
  const move = sessionOf(runtime).blendSpace!;

  assert.equal(runtime.setAnimationGraphParameter(heroId, "crouchSpeed", 0.5).success, true);
  const duck = runtime.setAnimationGraphParameter(heroId, "crouching", true);
  assert.equal(duck.transition?.transitionId, "duck");
  const crouch = sessionOf(runtime).blendSpace!;
  assert.notEqual(crouch, move);
  assert.equal(sessionOf(runtime).outgoingBlendSpace, move);
  assert.equal(crouch.definition.id, "crouch_locomotion");
  assert.deepEqual(crouch.state().input, { crouchSpeed: 0.5 });

  runtime.updateAnimation(0.1); // progress 0.25 of 0.4 s
  close(animation(runtime).graph?.blendProgress, 0.25);
  close(move.groupWeight, 0.75);
  close(crouch.groupWeight, 0.25);
  close(total(weightsByRole(runtime, "outgoing")) + total(weightsByRole(runtime, "incoming")), 1);

  runtime.updateAnimation(0.4);
  assert.equal(animation(runtime).graph?.transitioning, false);
  assert.equal(move.stopped, true);
  assert.equal(crouch.groupWeight, 1);
  assert.equal(animation(runtime).blendSpace?.id, "crouch_locomotion");
  close(total(weightsByRole(runtime, "blend")), 1);
  runtime.dispose();
});

test("an interrupted blend-space fade-in keeps its current weight as the new outgoing weight", async () => {
  const runtime = await heroRuntime();
  runtime.initAnimationGraph(heroId, graph());
  setSpeed(runtime, 2);
  runtime.updateAnimation(0.1); // move fading in at 0.5
  const move = sessionOf(runtime).blendSpace!;
  close(move.groupWeight, 0.5);
  const standAction = sessionOf(runtime).outgoingAction!;

  runtime.triggerAnimationGraph(heroId, "jump");
  assert.equal(animation(runtime).graph?.state, "leap");
  assert.equal(sessionOf(runtime).outgoingBlendSpace, move, "the half-faded space is the new outgoing side");
  assert.equal(sessionOf(runtime).blendSpace, undefined);
  assert.equal(standAction.isRunning(), false, "superseded outgoing clip is stopped");
  close(total(weightsByRole(runtime, "outgoing")), 0.5);

  runtime.updateAnimation(0.05);
  close(move.groupWeight, 0.25, 1e-9, "fromInitialWeight 0.5 * (1 - 0.5)");
  runtime.updateAnimation(0.1);
  assert.equal(animation(runtime).graph?.transitioning, false);
  assert.equal(move.stopped, true);
  assert.equal(sessionOf(runtime).outgoingBlendSpace, undefined);
  assert.deepEqual(animation(runtime).actions, [{ clip: "jump", weight: 1, role: "active" }]);
  runtime.dispose();
});

test("a graph whose entry state plays a blend space starts it at full weight", async () => {
  const runtime = await heroRuntime();
  const g = graph();
  g.entryState = "move";
  g.parameters.speed = { type: "number", default: 3 };
  const result = runtime.initAnimationGraph(heroId, g);
  assert.equal(result.success, true, result.error);
  const state = runtime.getBlendSpaceState(heroId)!;
  assert.equal(state.groupWeight, 1);
  assert.deepEqual(state.input, { speed: 3 });
  assert.equal(animation(runtime).graph?.state, "move");
  assert.equal(animation(runtime).graph?.transitioning, false);
  assert.equal(animation(runtime).graph?.blendProgress, 1);
  runtime.dispose();
});

test("clips shared between outgoing and incoming sides cut instead of crossfading", async () => {
  const runtime = await heroRuntime();
  const g = graph();
  // `stand` now plays "walk", which locomotion also samples.
  g.states[0] = { id: "stand", clipId: "walk" };
  runtime.initAnimationGraph(heroId, g);
  setSpeed(runtime, 1);
  assert.equal(animation(runtime).graph?.state, "move");
  assert.equal(animation(runtime).graph?.transitioning, false, "cut: no fade through a shared action");
  assert.equal(animation(runtime).graph?.blendProgress, 1);
  assert.equal(sessionOf(runtime).outgoingAction, undefined);
  const space = sessionOf(runtime).blendSpace!;
  assert.equal(space.groupWeight, 1);
  close(space.getAction("walk")?.getEffectiveWeight(), 1);
  assert.equal(space.getAction("walk")?.isRunning(), true);

  // And back out: stand plays "walk", also a sample of the fading-out space.
  const out = runtime.setAnimationGraphParameter(heroId, "speed", 0);
  assert.equal(out.transition?.to, "stand");
  assert.equal(animation(runtime).graph?.transitioning, false);
  assert.equal(space.stopped, true);
  assert.equal(sessionOf(runtime).outgoingBlendSpace, undefined);
  assert.deepEqual(animation(runtime).actions, [{ clip: "walk", weight: 1, role: "active" }]);
  runtime.dispose();
});

test("setBlendSpaceInput refuses a graph-owned blend space; manual playBlendSpace takes it over", async () => {
  const runtime = await heroRuntime();
  runtime.initAnimationGraph(heroId, graph());
  setSpeed(runtime, 2);
  runtime.updateAnimation(0.25);
  const result = runtime.setBlendSpaceInput(heroId, { speed: 3 });
  assert.equal(result.success, false);
  assert.equal(result.code, "anim.blendSpace.graphDriven");
  assert.deepEqual(runtime.getBlendSpaceState(heroId)?.input, { speed: 2 }, "input untouched");

  const manual = runtime.playBlendSpace(heroId, locomotion, { input: { speed: 1 } });
  assert.equal(manual.success, true, manual.error);
  assert.equal(sessionOf(runtime).blendSpaceStateId, undefined);
  assert.equal(runtime.setBlendSpaceInput(heroId, { speed: 3 }).success, true);
  runtime.dispose();
});

test("initAnimationGraph rejects bad blend-space graphs without disturbing current playback", async () => {
  const runtime = await heroRuntime();
  assert.equal(runtime.playAnimation(heroId, "stand"), true);
  const before = sessionOf(runtime).activeAction;

  const unknown = graph();
  unknown.states[1]!.blendSpaceId = "nope";
  const r1 = runtime.initAnimationGraph(heroId, unknown);
  assert.equal(r1.success, false);
  assert.equal(r1.diagnostics?.[0]?.code, "anim.state.blendSpace.unknown");

  const missingClip = graph();
  missingClip.blendSpaces = [
    { ...locomotion, samples: [{ clipId: "walk", position: 1 }, { clipId: "sprint", position: 3 }] } as BlendSpaceDefinition,
    crouchLocomotion,
  ];
  const r2 = runtime.initAnimationGraph(heroId, missingClip);
  assert.equal(r2.success, false);
  assert.equal(r2.diagnostics?.[0]?.code, "anim.blendSpace.clip.unknown");
  assert.match(r2.diagnostics?.[0]?.message ?? "", /"sprint"/);

  assert.equal(sessionOf(runtime).graphMachine, undefined);
  assert.equal(sessionOf(runtime).activeAction, before);
  assert.equal(before?.isRunning(), true);
  runtime.dispose();
});

test("root motion and graph blend spaces refuse each other with a structured code", async () => {
  const runtime = await heroRuntime();
  runtime.initAnimationGraph(heroId, graph());
  const enabled = runtime.configureRootMotion(heroId, { enabled: true, rootBoneName: "AnimatedBoxNode" });
  assert.equal(enabled.success, false);
  assert.equal(enabled.diagnostics?.code, "anim.blendSpace.rootMotionUnsupported");
  runtime.dispose();

  const other = await heroRuntime();
  assert.equal(other.configureRootMotion(heroId, { enabled: true, rootBoneName: "AnimatedBoxNode" }).success, true);
  const init = other.initAnimationGraph(heroId, graph());
  assert.equal(init.success, false);
  assert.equal(init.diagnostics?.[0]?.code, "anim.blendSpace.rootMotionUnsupported");
  other.dispose();
});

test("stopAnimation, detach and dispose release a blend space that is mid-fade", async () => {
  const runtime = await heroRuntime();
  runtime.initAnimationGraph(heroId, graph());
  setSpeed(runtime, 2);
  runtime.updateAnimation(0.25);
  runtime.setAnimationGraphParameter(heroId, "speed", 0);
  const fading = sessionOf(runtime).outgoingBlendSpace!;
  runtime.stopAnimation(heroId);
  assert.equal(fading.stopped, true);
  assert.equal(sessionOf(runtime).outgoingBlendSpace, undefined);
  assert.equal(animation(runtime).blendSpace, undefined);

  // Mid-fade dispose.
  runtime.initAnimationGraph(heroId, graph());
  setSpeed(runtime, 2);
  runtime.updateAnimation(0.25);
  runtime.setAnimationGraphParameter(heroId, "speed", 0);
  const again = sessionOf(runtime).outgoingBlendSpace!;
  runtime.dispose();
  assert.equal(again.stopped, true);
});

test("live reload rebuilds a graph-driven blend space from the graph instead of restoring it standalone", async () => {
  let revision = 1;
  const glb = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = {
    resolve: (id) => (id === ASSET_BOT ? glb : undefined),
    getFingerprint: (id) => (id === ASSET_BOT ? `fp_bot_v${revision}` : undefined),
  };
  const runtime = await ThreeSceneRuntime.instantiateAsync(project(ASSET_BOT), sceneId, { assetResolver: resolver });
  const g: AnimationGraphDefinition = {
    schemaVersion: 1,
    entryState: "move",
    parameters: { speed: { type: "number", default: 0.5 } },
    blendSpaces: [
      {
        schemaVersion: 1,
        kind: "1d",
        id: "bot_speed",
        parameter: "speed",
        samples: [
          { clipId: "idle", position: 0 },
          { clipId: "walk", position: 1 },
        ],
      },
    ],
    states: [{ id: "move", blendSpaceId: "bot_speed" }],
    transitions: [],
  };
  const init = runtime.initAnimationGraph(heroId, g);
  assert.equal(init.success, true, init.error);
  const before = sessionOf(runtime).blendSpace!;

  revision = 2;
  const reload = await runtime.reloadAsset(ASSET_BOT, resolver);
  assert.equal(reload.success, true, reload.error);
  assert.equal(before.stopped, true);
  const after = sessionOf(runtime).blendSpace!;
  assert.notEqual(after, before);
  assert.equal(sessionOf(runtime).blendSpaceStateId, "move", "still owned by the graph, so parameters keep driving it");
  assert.equal(runtime.setBlendSpaceInput(heroId, { speed: 1 }).code, "anim.blendSpace.graphDriven");
  assert.equal(runtime.setAnimationGraphParameter(heroId, "speed", 1).success, true);
  assert.deepEqual(runtime.getBlendSpaceState(heroId)?.input, { speed: 1 });
  runtime.dispose();
});
