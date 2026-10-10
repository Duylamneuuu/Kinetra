import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { ThreeSceneRuntime, type RuntimeAnimationEvent } from "../src/index.js";

async function rig(): Promise<{ runtime: ThreeSceneRuntime; hero: string; duration: number }> {
  const sceneId = stableId("scene", "anim-events-flush-order");
  const hero = stableId("entity", "anim_events_flush_order_hero");
  const doc: ProjectDocument = {
    schemaVersion: 1,
    projectId: stableId("project", "anim-events-flush-order"),
    name: "Animation event delivery order",
    scenes: [
      {
        id: sceneId,
        name: "Animation event delivery order",
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

test("a listener that advances the animation cannot reorder delivery: log and listeners see strict sequence order", async () => {
  const { runtime, hero, duration } = await rig();
  runtime.setAnimationEvents([
    { clip: "walk", time: duration * 0.25, name: "a" },
    { clip: "walk", time: duration * 0.75, name: "b" },
  ]);
  runtime.playAnimation(hero, "walk", { loop: true });

  const seen: RuntimeAnimationEvent[] = [];
  let reentered = false;
  runtime.onAnimationEvent((event) => {
    seen.push(event);
    if (!reentered) {
      reentered = true;
      // A gameplay reaction that steps the animation again from inside the callback.
      runtime.updateAnimation(duration);
    }
  });

  // One step crosses both events: two events are queued in the same batch.
  runtime.updateAnimation(duration * 0.8);

  const log = runtime.getAnimationEventLog();
  assert.ok(log.length >= 4, `expected the nested step to add events (got ${log.length})`);
  const sequences = log.map((e) => e.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((x, y) => x - y),
    `log must be in firing order, got sequences ${sequences.join(",")}`,
  );
  assert.deepEqual(
    seen.map((e) => e.sequence),
    sequences,
    "listeners must be called in the same order as the log",
  );
  runtime.dispose();
});
