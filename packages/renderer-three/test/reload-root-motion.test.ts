import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb, createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";

import { ThreeSceneRuntime, type AssetResolver } from "../src/index.js";

const sceneId = stableId("scene", "reload-root-motion");
const heroId = stableId("entity", "reload_root_motion_hero");

function projectDoc(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: stableId("project", "reload-root-motion"),
    name: "Reload keeps root motion",
    scenes: [
      {
        id: sceneId,
        name: "Reload keeps root motion",
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

async function rig(): Promise<{ runtime: ThreeSceneRuntime; resolver: AssetResolver }> {
  const glb = await createSyntheticCharacterGlb();
  const resolver: AssetResolver = { resolve: (id) => (id === "bot" ? glb : undefined) };
  const runtime = await ThreeSceneRuntime.instantiateAsync(projectDoc(), sceneId, { assetResolver: resolver });
  return { runtime, resolver };
}

test("reloading the asset keeps root motion enabled with the same mode and root bone", async () => {
  const { runtime, resolver } = await rig();
  const configured = runtime.configureRootMotion(heroId, {
    enabled: true,
    mode: "extract-xz-yaw",
    rootBoneName: "Hips",
  });
  assert.equal(configured.success, true, configured.error);

  const reloaded = await runtime.reloadAsset("bot", resolver);
  assert.equal(reloaded.success, true);
  assert.deepEqual(reloaded.affectedEntities, [heroId]);
  assert.equal(reloaded.droppedRootMotion, undefined);

  const rootMotion = runtime.getAnimatorSession(heroId)?.rootMotion;
  assert.equal(rootMotion?.enabled, true, "root motion must survive a hot reimport");
  assert.equal(rootMotion?.mode, "extract-xz-yaw");
  assert.equal(rootMotion?.rootBoneName, "Hips");
  runtime.dispose();
});

test("reloading reports root motion that the new asset cannot keep", async () => {
  const { runtime } = await rig();
  assert.equal(runtime.configureRootMotion(heroId, { enabled: true, rootBoneName: "Hips" }).success, true);

  // A reload whose bytes have no "Hips" bone: modelled by a glb of a plain box.
  const box = await createSyntheticGlb({ size: [1, 1, 1] });
  const reloaded = await runtime.reloadAsset("bot", { resolve: () => box });

  assert.equal(reloaded.success, true);
  assert.ok(reloaded.droppedRootMotion?.[heroId], "the entity must be listed with the reason");
  assert.notEqual(runtime.getAnimatorSession(heroId)?.rootMotion?.enabled, true);
  runtime.dispose();
});
