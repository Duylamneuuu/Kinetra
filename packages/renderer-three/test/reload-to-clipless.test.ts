import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb, createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { ThreeSceneRuntime } from "../src/index.js";

const sceneId = stableId("scene", "reload-to-clipless");
const heroId = stableId("entity", "reload_to_clipless_hero");

function projectDoc(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "reload-to-clipless"),
    name: "Reload to a clip-less asset",
    scenes: [
      {
        id: sceneId,
        name: "Reload to a clip-less asset",
        entities: [
          {
            id: heroId,
            name: "Hero",
            components: { Transform: { position: [0, 0, 0] }, Model: { assetId: "bot" } },
          },
        ],
      },
    ],
  };
}

test("reloading an animated asset into one without clips drops the stale animation metadata", async () => {
  const character = await createSyntheticCharacterGlb();
  const runtime = await ThreeSceneRuntime.instantiateAsync(projectDoc(), sceneId, {
    assetResolver: { resolve: () => character },
  });
  const before = runtime.getModelMetadata(heroId)?.animation;
  assert.ok(before && before.clips.length > 0, "the character asset must start with clips");
  assert.ok(runtime.getAnimatorSession(heroId), "and an animator session");

  const box = await createSyntheticGlb({ size: [1, 1, 1] });
  const reloaded = await runtime.reloadAsset("bot", { resolve: () => box });
  assert.equal(reloaded.success, true);
  assert.deepEqual(reloaded.affectedEntities, [heroId]);

  assert.equal(runtime.getAnimatorSession(heroId), undefined, "a clip-less asset has no animator session");
  assert.equal(
    runtime.getModelMetadata(heroId)?.animation,
    undefined,
    "metadata must not keep advertising the previous asset's clips",
  );
  runtime.dispose();
});
