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

test("P5 morph targets drive blend shapes by name in the real Electron runtime", async (t) => {
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
    await probe.start(SCENE_ID, 901);
    const initial = await host.query();
    assert.equal(initial.running, true);

    const catalog = morphOf(initial.entities, HEAD_A);
    assert.ok(catalog, "loaded model must expose its morph-target catalog");
    assert.deepEqual(
      catalog.targets.map((target) => [target.name, target.meshes]),
      [
        ["blink", ["Face", "Brow"]],
        ["raise", ["Brow"]],
        ["smile", ["Face"]],
      ],
    );
    assert.equal(targetWeight(initial.entities, HEAD_A, "smile"), 0.25);
    assert.deepEqual(catalog.overrides, {});

    await t.test("setMorphWeights applies a shared name and only touches the addressed instance", async () => {
      const result = await host.setMorphWeights(HEAD_A, { blink: 0.75, smile: 1 });
      assert.equal(result.success, true, result.error);
      const after = await host.step(2, 1 / 60);
      assert.deepEqual(morphOf(after.entities, HEAD_A)?.overrides, { blink: 0.75, smile: 1 });
      assert.equal(targetWeight(after.entities, HEAD_A, "blink"), 0.75);
      assert.equal(targetWeight(after.entities, HEAD_A, "smile"), 1);
      assert.deepEqual(morphOf(after.entities, HEAD_B)?.overrides, {});
      assert.equal(targetWeight(after.entities, HEAD_B, "smile"), 0.25);
    });

    await t.test("invalid requests return structured diagnostics and change nothing", async () => {
      const unknown = await host.setMorphWeights(HEAD_A, { frown: 1 });
      assert.equal(unknown.success, false);
      assert.equal(unknown.diagnostics?.[0]?.code, "anim.morph.unknownTarget");
      const range = await host.setMorphWeights(HEAD_A, { smile: 3 });
      assert.equal(range.success, false);
      assert.equal(range.diagnostics?.[0]?.code, "anim.morph.weightOutOfRange");
      const noTargets = await host.setMorphWeights(FLOOR, { smile: 1 });
      assert.equal(noTargets.success, false);
      assert.equal(noTargets.diagnostics?.[0]?.code, "anim.morph.noModel");
      const state = await host.query();
      assert.deepEqual(morphOf(state.entities, HEAD_A)?.overrides, { blink: 0.75, smile: 1 });
    });

    await t.test("an override wins over a clip animating the same target", async () => {
      await host.playAnimation(HEAD_A, "Blink", { loop: true });
      const during = await host.step(30, 1 / 60);
      assert.equal(targetWeight(during.entities, HEAD_A, "blink"), 0.75);

      const cleared = await host.clearMorphWeights(HEAD_A, ["blink"]);
      assert.equal(cleared.success, true, cleared.error);
      assert.deepEqual(cleared.cleared, ["blink"]);
      // 30 frames into a 1 s loop the clip is at ~0.5 s, where blink peaks at 1.
      const animated = await host.step(30, 1 / 60);
      const blink = targetWeight(animated.entities, HEAD_A, "blink");
      assert.ok(blink !== undefined && blink !== 0.75, `clip must own blink again, got ${blink}`);
      assert.deepEqual(morphOf(animated.entities, HEAD_A)?.overrides, { smile: 1 });
    });

    await t.test("clearing every override restores authored weights", async () => {
      await host.stopAnimation(HEAD_A);
      const cleared = await host.clearMorphWeights(HEAD_A);
      assert.equal(cleared.success, true, cleared.error);
      assert.deepEqual(cleared.cleared, ["smile"]);
      const state = await host.step(1, 1 / 60);
      assert.deepEqual(morphOf(state.entities, HEAD_A)?.overrides, {});
      assert.equal(targetWeight(state.entities, HEAD_A, "smile"), 0.25);
    });

    const frame = await host.captureFrame();
    assert.equal(frame.available, true, frame.reason);
    assert.ok((frame.base64?.length ?? 0) > 1000, "a rendered frame must be produced with morphed meshes");
  } finally {
    await probe.stop().catch(() => undefined);
    await host.close();
  }
});
