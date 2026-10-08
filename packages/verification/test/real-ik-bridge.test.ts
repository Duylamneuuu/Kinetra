import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticMorphGlb } from "@kinetra/asset-pipeline";
import type { ProjectDocument } from "@kinetra/project-model";

import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
  type RuntimeEntityState,
} from "../src/index.js";

const SCENE_ID = "scene_morph_targets";
const HEAD_A = "entity_morph_head_a";
const HEAD_B = "entity_morph_head_b";
const FLOOR = "entity_morph_floor";
const MORPH_ASSET_ID = "asset_morph_head";

function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    electronArgs: realElectronLaunchArgs(),
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

function createProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_morph_targets",
    name: "Morph Target Verification",
    scenes: [
      {
        id: SCENE_ID,
        name: "Morph Scene",
        entities: [
          {
            id: "camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 100 },
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
            id: FLOOR,
            name: "Floor",
            components: {
              Transform: { position: [0, -0.05, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Primitive: { kind: "box", size: [8, 0.1, 8], color: "#202430" },
            },
          },
          {
            id: HEAD_A,
            name: "HeadA",
            components: {
              Transform: { position: [-1.2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: MORPH_ASSET_ID },
            },
          },
          {
            id: HEAD_B,
            name: "HeadB",
            components: {
              Transform: { position: [1.2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: MORPH_ASSET_ID },
            },
          },
        ],
      },
    ],
  } as ProjectDocument;
}

function morphOf(entities: RuntimeEntityState[], id: string) {
  const entity = entities.find((e) => e.entityId === id);
  assert.ok(entity, `entity ${id} must be observable`);
  return entity.model?.morphTargets;
}

function targetWeight(entities: RuntimeEntityState[], id: string, name: string): number | undefined {
  return morphOf(entities, id)?.targets.find((t) => t.name === name)?.weight;
}

test("P5 IK bridge ops return structured results in the real Electron runtime", async (t) => {
  if (!canRunRealElectronTests()) {
    t.skip("Real Electron test requires an active display (Windows or Linux under X11/xvfb)");
    return;
  }

  const glb = await createSyntheticMorphGlb({ faceWeights: [0.25, 0], blinkDuration: 1 });
  const host = createHost();
  const probe = new KinetraRuntimeProbe({
    host,
    project: () => createProject(),
    initialRevision: 0,
    assets: { [MORPH_ASSET_ID]: Buffer.from(glb).toString("base64") },
    closeOnStop: false,
  });

  try {
    await probe.start(SCENE_ID, 902);

    await t.test("setIkTarget before any chains is a structured failure", async () => {
      const result = await host.setIkTarget(HEAD_A, "arm", [0, 1, 0]);
      assert.equal(result.success, false);
      assert.equal(result.diagnostics?.[0]?.code, "ik.runtime.no-chains");
    });

    await t.test("setIkChains rejects a non-array payload", async () => {
      const result = await host.setIkChains(HEAD_A, "nope" as unknown as unknown[]);
      assert.equal(result.success, false);
      assert.match(result.error ?? "", /array/);
    });

    await t.test("setIkChains on a model without bones skips invalid chains and never throws", async () => {
      const result = await host.setIkChains(HEAD_A, [{ id: "arm" }, 42]);
      assert.equal(result.success, true);
      assert.deepEqual(result.registered, []);
      const target = await host.setIkTarget(HEAD_A, "arm", [0, 1, 0]);
      assert.equal(target.success, false);
      assert.equal(target.diagnostics?.[0]?.code, "ik.target.unknown-chain");
    });

    await t.test("unknown entity fails and clearIkTarget is harmless", async () => {
      const result = await host.setIkChains("entity_missing", []);
      assert.equal(result.success, false);
      const cleared = await host.clearIkTarget(HEAD_A);
      assert.equal(cleared.success, true);
    });
  } finally {
    await probe.stop().catch(() => undefined);
    await host.close();
  }
});
