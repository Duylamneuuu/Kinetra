import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import * as THREE from "three";

import {
  MAX_ANIMATION_EVENT_LOG,
  ThreeSceneRuntime,
  type RuntimeAnimationEvent,
} from "../src/index.js";

interface Rig {
  runtime: ThreeSceneRuntime;
  hero: string;
  /** Duration of the "walk" clip in seconds. */
  duration: number;
}

async function rig(): Promise<Rig> {
  const sceneId = stableId("scene", "anim-events");
  const hero = stableId("entity", "anim_events_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "anim-events"),
    name: "Animation events",
    scenes: [
      {
        id: sceneId,
        name: "Animation events",
        entities: [
          {
            id: hero,
            name: "Hero",
            components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } },
          },
        ],
      },
    ],
  };
  const glb = await createSyntheticCharacterGlb();
  const runtime = await ThreeSceneRuntime.instantiateAsync(doc, sceneId, {
    assetResolver: { resolve: (id) => (id === "bot" ? glb : undefined) },
  });
  const clip = runtime.getModelMetadata(hero)?.animation?.clips.find((c) => c.name === "walk");
  assert.ok(clip && clip.duration > 0, "synthetic character needs a walk clip");
  return { runtime, hero, duration: clip.duration };
}

function names(events: readonly RuntimeAnimationEvent[]): string[] {
  return events.map((e) => e.name);
}

function stepMany(runtime: ThreeSceneRuntime, total: number, dt: number): void {
  const steps = Math.round(total / dt);
  for (let i = 0; i < steps; i += 1) runtime.updateAnimation(dt);
}

test("looping clip fires each event once per loop, independent of step size", async () => {
  const counts: number[] = [];
  for (const dt of [1 / 60, 1 / 30, 0.125]) {
    const { runtime, hero, duration } = await rig();
    const result = runtime.setAnimationEvents([
      { clip: "walk", time: duration / 2, name: "mid", payload: { foot: "left" } },
      { clip: "walk", time: duration * 0.9, name: "late" },
    ]);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(runtime.playAnimation(hero, "walk", { loop: true }), true);
    stepMany(runtime, duration * 3 - 0.001, dt);
    const log = runtime.getAnimationEventLog();
    assert.deepEqual(names(log).filter((n) => n === "mid").length, 3, `mid count at dt=${dt}`);
    assert.deepEqual(names(log).filter((n) => n === "late").length, 3, `late count at dt=${dt}`);
    assert.ok(log.every((e) => e.entityId === hero && e.clip === "walk"));
    // Sequence numbers are strictly increasing, positions non-decreasing.
    for (let i = 1; i < log.length; i += 1) {
      assert.ok(log[i]!.sequence > log[i - 1]!.sequence);
      assert.ok(log[i]!.position >= log[i - 1]!.position - 1e-9);
    }
    counts.push(log.length);
    runtime.dispose();
  }
  assert.deepEqual(counts, [6, 6, 6]);
});

test("an event at time 0 fires on the first movement and again on every restart", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: 0, name: "start" }]);
  runtime.playAnimation(hero, "walk", { loop: true });
  runtime.updateAnimation(0.05);
  assert.deepEqual(names(runtime.getAnimationEventLog()), ["start"]);
  runtime.updateAnimation(0.05);
  assert.equal(runtime.getAnimationEventLog().length, 1, "no refire while the clip keeps playing");

  // Restarting the same clip rewinds it to 0, so the start event is due again.
  runtime.playAnimation(hero, "walk", { loop: true });
  runtime.updateAnimation(0.05);
  assert.equal(runtime.getAnimationEventLog().length, 2);

  // A loop wrap fires it too (event at 0 belongs to the new iteration).
  runtime.updateAnimation(duration);
  assert.equal(runtime.getAnimationEventLog().length, 3);
  runtime.dispose();
});

test("non-looping clip fires every event once and nothing after the end", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([
    { clip: "walk", time: duration * 0.25, name: "a" },
    { clip: "walk", time: duration, name: "end" },
  ]);
  runtime.playAnimation(hero, "walk", { loop: false });
  stepMany(runtime, duration * 2, 1 / 30);
  assert.deepEqual(names(runtime.getAnimationEventLog()), ["a", "end"]);
  runtime.updateAnimation(1);
  assert.equal(runtime.getAnimationEventLog().length, 2);
  runtime.dispose();
});

test("action time scale and mixer time scale change when events fire, not how often", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: duration / 2, name: "mid" }]);
  runtime.playAnimation(hero, "walk", { loop: true });
  const session = runtime.getAnimatorSession(hero)!;
  session.activeAction!.setEffectiveTimeScale(2);
  // Two real seconds at 2x cover 4 seconds of clip time.
  stepMany(runtime, 2, 1 / 30);
  const fast = runtime.getAnimationEventLog().length;
  assert.equal(fast, Math.floor(4 / duration + 0.5), "events follow clip time");

  runtime.clearAnimationEventLog();
  session.mixer.timeScale = 0.5;
  session.activeAction!.time = 0;
  session.activeAction!.setEffectiveTimeScale(1);
  stepMany(runtime, duration * 3.4, 1 / 30);
  // 3.4*duration real seconds at 0.5x = 1.7 loops -> the midpoint is crossed twice (0.5 and 1.5 loops).
  assert.equal(runtime.getAnimationEventLog().length, 2);
  runtime.dispose();
});

test("a paused action fires nothing and resumes without a burst", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: duration / 2, name: "mid" }]);
  runtime.playAnimation(hero, "walk", { loop: true });
  const action = runtime.getAnimatorSession(hero)!.activeAction!;
  action.paused = true;
  stepMany(runtime, duration * 2, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 0);
  action.paused = false;
  stepMany(runtime, duration, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 1);
  runtime.dispose();
});

test("a manual time jump re-syncs the tracker without firing the skipped range", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([
    { clip: "walk", time: duration * 0.2, name: "early" },
    { clip: "walk", time: duration * 0.6, name: "mid" },
  ]);
  runtime.playAnimation(hero, "walk", { loop: true });
  runtime.updateAnimation(0.01);
  const action = runtime.getAnimatorSession(hero)!.activeAction!;
  action.time = duration * 0.5; // jump over "early"
  runtime.updateAnimation(duration * 0.05);
  assert.equal(runtime.getAnimationEventLog().length, 0, "the jump itself fires nothing");
  runtime.updateAnimation(duration * 0.2);
  assert.deepEqual(names(runtime.getAnimationEventLog()), ["mid"]);
  runtime.dispose();
});

test("the outgoing clip of a crossfade keeps firing its events until the fade ends", async () => {
  const { runtime, hero, duration } = await rig();
  assert.equal(runtime.registerAnimationClip(hero, new THREE.AnimationClip("extra", 2, [])), true);
  runtime.setAnimationEvents([
    { clip: "walk", time: duration * 0.5, name: "walk-mid" },
    { clip: "extra", time: 1, name: "extra-mid" },
  ]);
  runtime.playAnimation(hero, "walk", { loop: true });
  runtime.updateAnimation(duration * 0.4);
  assert.equal(runtime.crossfadeAnimation(hero, "extra", 1, { loop: true }), true);
  stepMany(runtime, 0.5, 1 / 30);
  const during = names(runtime.getAnimationEventLog());
  assert.ok(during.includes("walk-mid"), "outgoing clip still reports its event");
  stepMany(runtime, 2, 1 / 30);
  assert.ok(names(runtime.getAnimationEventLog()).includes("extra-mid"));
  runtime.dispose();
});

test("listeners receive copies, can unsubscribe, and exceptions are isolated", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: duration / 2, name: "mid", payload: { n: 1 } }]);
  const seen: RuntimeAnimationEvent[] = [];
  runtime.onAnimationEvent(() => {
    throw new Error("bad listener");
  });
  const off = runtime.onAnimationEvent((event) => {
    (event.payload as { n: number }).n = 99; // must not leak into the log or other listeners
    seen.push(event);
  });
  const second: number[] = [];
  runtime.onAnimationEvent((event) => second.push((event.payload as { n: number }).n));

  runtime.playAnimation(hero, "walk", { loop: true });
  stepMany(runtime, duration, 1 / 30);
  assert.equal(seen.length, 1);
  assert.deepEqual(second, [1]);
  assert.equal((runtime.getAnimationEventLog()[0]!.payload as { n: number }).n, 1);
  assert.equal(runtime.getAnimationEventStats().listenerErrors, 1);
  assert.equal(runtime.getAnimationEventStats().fired, 1);

  off();
  stepMany(runtime, duration, 1 / 30);
  assert.equal(seen.length, 1, "unsubscribed listener is not called again");
  assert.equal(runtime.getAnimationEventLog().length, 2);
  assert.throws(() => runtime.onAnimationEvent(undefined as never), TypeError);
  runtime.dispose();
});

test("invalid event definitions come back as diagnostics and never fire", async () => {
  const { runtime, hero, duration } = await rig();
  const bad = runtime.setAnimationEvents("nope");
  assert.equal(bad.events.length, 0);
  assert.equal(bad.diagnostics[0]!.code, "animation.events.notArray");

  const mixed = runtime.setAnimationEvents([
    { clip: "walk", time: -1, name: "negative" },
    { clip: "walk", time: Number.NaN, name: "nan" },
    { clip: "", time: 0, name: "noclip" },
    { clip: "walk", time: duration / 2, name: "ok" },
    { clip: "never-registered", time: 0.1, name: "ghost" },
  ]);
  assert.equal(mixed.events.length, 2);
  assert.equal(mixed.diagnostics.filter((d) => d.severity === "error").length, 3);

  runtime.playAnimation(hero, "walk", { loop: true });
  stepMany(runtime, duration, 1 / 30);
  assert.deepEqual(names(runtime.getAnimationEventLog()), ["ok"]);

  // Replacing the set with an empty array stops events immediately.
  runtime.setAnimationEvents([]);
  runtime.clearAnimationEventLog();
  stepMany(runtime, duration * 2, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 0);
  runtime.dispose();
});

test("a ping-pong loop is reported once and fires nothing", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: duration / 2, name: "mid" }]);
  runtime.playAnimation(hero, "walk", { loop: true });
  runtime.getAnimatorSession(hero)!.activeAction!.loop = THREE.LoopPingPong;
  stepMany(runtime, duration * 2, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 0);
  const diagnostics = runtime.getAnimationEventDiagnostics();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.code, "animation.events.pingPongUnsupported");
  runtime.dispose();
});

test("the event log is bounded and counts evictions", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: 0.0001, name: "tick" }]);
  runtime.playAnimation(hero, "walk", { loop: true });
  const total = MAX_ANIMATION_EVENT_LOG + 40;
  for (let i = 0; i < total; i += 1) runtime.updateAnimation(duration);
  assert.equal(runtime.getAnimationEventLog().length, MAX_ANIMATION_EVENT_LOG);
  const stats = runtime.getAnimationEventStats();
  assert.equal(stats.fired, total);
  assert.equal(stats.evicted, 40);
  // The newest event is still the last one.
  assert.equal(runtime.getAnimationEventLog().at(-1)!.sequence, total);
  runtime.dispose();
});

test("detach, stop and dispose leave no events behind; reload keeps working", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: duration / 2, name: "mid" }]);
  runtime.playAnimation(hero, "walk", { loop: true });
  stepMany(runtime, duration, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 1);

  runtime.stopAnimation(hero);
  stepMany(runtime, duration, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 1, "a stopped animation fires nothing");

  runtime.playAnimation(hero, "walk", { loop: true });
  stepMany(runtime, duration, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 2, "playing again fires again");

  assert.equal(runtime.detachModel(hero).success, true);
  runtime.updateAnimation(duration); // no session, no throw
  assert.equal(runtime.getAnimationEventLog().length, 2);

  runtime.dispose();
  assert.equal(runtime.getAnimationEventLog().length, 0);
  runtime.updateAnimation(0.1); // disposed: ignored
});

test("non-finite steps do not fire or corrupt the tracker", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([{ clip: "walk", time: duration / 2, name: "mid" }]);
  runtime.playAnimation(hero, "walk", { loop: true });
  runtime.updateAnimation(Number.NaN);
  runtime.updateAnimation(Number.POSITIVE_INFINITY);
  runtime.updateAnimation(-1);
  assert.equal(runtime.getAnimationEventLog().length, 0);
  stepMany(runtime, duration, 1 / 30);
  assert.equal(runtime.getAnimationEventLog().length, 1);
  runtime.dispose();
});
