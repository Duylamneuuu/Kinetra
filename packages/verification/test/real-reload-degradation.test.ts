import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticCharacterGlb, createSyntheticGlb } from "@kinetra/asset-pipeline";
import type { ProjectDocument } from "@kinetra/project-model";

import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
} from "../src/index.js";

/**
 * #558 item 5: a unit probe can forward `droppedRootMotion`, but that does not prove the live
 * Electron reply. `model.reloadAsset` is answered by the renderer (`reloadAsset` plus `query()`),
 * then serialized across the bridge. This test drives that path: root motion is enabled on a
 * rigged character, the asset is replaced by a mesh with no root bone, and the bridge reply must
 * still carry the entity's drop reason.
 */

const SCENE_ID = "scene_reload_degradation";
const HERO_ID = "entity_reload_degradation_hero";
const ASSET_ID = "asset_reload_degradation_hero";

function project(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_reload_degradation",
    name: "Reload degradation bridge",
    scenes: [
      {
        id: SCENE_ID,
        name: "Reload degradation",
        entities: [
          {
            id: "camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 1.5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
            },
          },
          {
            id: "sun",
            name: "DirectionalSun",
            components: {
              Transform: { position: [2, 5, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Light: { kind: "directional", color: "#ffffff", intensity: 2 },
            },
          },
          {
            id: HERO_ID,
            name: "Hero",
            components: {
              Transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ASSET_ID },
            },
          },
        ],
      },
    ],
  };
}

test(
  "a live model.reloadAsset reply carries droppedRootMotion (Refs #558)",
  { skip: !canRunRealElectronTests(), timeout: 90_000 },
  async () => {
    const character = await createSyntheticCharacterGlb();
    const host = new ElectronRuntimeHost({
      requestTimeoutMs: 30_000,
      electronArgs: realElectronLaunchArgs(),
      ...(process.env.KINETRA_RUNTIME_EXECUTABLE
        ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
        : {}),
    });
    const probe = new KinetraRuntimeProbe({
      host,
      project,
      initialRevision: 0,
      assets: { [ASSET_ID]: Buffer.from(character).toString("base64") },
      closeOnStop: false,
    });

    try {
      await probe.start(SCENE_ID, 1);
      await probe.step(2, 1 / 30);

      const configured = await host.configureRootMotion({
        entityId: HERO_ID,
        enabled: true,
        rootBoneName: "Hips",
      });
      assert.equal(configured.success, true, configured.error ?? "root motion must configure");

      const box = await createSyntheticGlb({ size: [1, 1, 1] });
      await probe.updateAsset!(ASSET_ID, Buffer.from(box).toString("base64"), {
        fingerprint: "fp_reload_degradation_box",
      });

      const reloaded = await probe.reloadAsset!(ASSET_ID);
      assert.equal(reloaded.success, true, reloaded.error ?? "reload must succeed");
      assert.deepEqual(reloaded.affectedEntities, [HERO_ID]);
      const reason = reloaded.droppedRootMotion?.[HERO_ID];
      assert.equal(typeof reason, "string", "the bridge reply must include droppedRootMotion");
      assert.ok(reason && reason.length > 0, "the drop reason must be non-empty");
    } finally {
      await probe.close();
    }
  },
);
