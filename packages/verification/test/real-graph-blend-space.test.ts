import assert from "node:assert/strict";
import test from "node:test";

import type { AnimationGraphDefinition } from "@kinetra/animation/graph.js";
import type { ProjectDocument } from "@kinetra/project-model";
import { ARENA_ENEMY_MODEL_ASSET_ID, arenaAssets } from "@kinetra/reference-game";
import {
  canRunRealElectronTests,
  ElectronRuntimeHost,
  KinetraRuntimeProbe,
  realElectronLaunchArgs,
  type RuntimeEntityState,
} from "../src/index.js";

const SCENE_ID = "scene_graph_blend_space";
const ENTITY_BLENDED = "entity_blend_bot";
const ENTITY_REFERENCE = "entity_reference_bot";

function createHost(): ElectronRuntimeHost {
  return new ElectronRuntimeHost({
    requestTimeoutMs: 30_000,
    electronArgs: realElectronLaunchArgs(),
    ...(process.env.KINETRA_RUNTIME_EXECUTABLE
      ? { runtimeExecutable: process.env.KINETRA_RUNTIME_EXECUTABLE }
      : {}),
  });
}

/** Two script-free rigged bots so nothing but the test drives their animation. */
function createBlendSpaceProject(): ProjectDocument {
  return {
    schemaVersion: 1,
    projectId: "project_graph_blend_space_verification",
    name: "Graph Blend Space Verification Project",
    scenes: [
      {
        id: SCENE_ID,
        name: "Graph Blend Space Scene",
        entities: [
          {
            id: "camera",
            name: "MainCamera",
            components: {
              Transform: { position: [0, 2, 6], rotation: [-0.1, 0, 0], scale: [1, 1, 1] },
              Camera: { type: "perspective", fov: 60, near: 0.1, far: 1000 },
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
            id: "floor",
            name: "Floor",
            components: {
              Transform: { position: [0, -0.05, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Primitive: { kind: "box", size: [12, 0.1, 12], color: "#1a1e28" },
            },
          },
          {
            id: ENTITY_BLENDED,
            name: "BlendBot",
            components: {
              Transform: { position: [-1.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
          {
            id: ENTITY_REFERENCE,
            name: "ReferenceBot",
            components: {
              Transform: { position: [1.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              Model: { assetId: ARENA_ENEMY_MODEL_ASSET_ID },
            },
          },
        ],
      },
    ],
  };
}

const GRAPH: AnimationGraphDefinition = {
  schemaVersion: 1,
  entryState: "stand",
  parameters: { speed: { type: "number", default: 0 } },
  blendSpaces: [
    {
      schemaVersion: 1,
      kind: "1d",
      id: "bot_speed",
      parameter: "speed",
      samples: [
        { clipId: "walk", position: 1 },
        { clipId: "attack", position: 2 },
      ],
    },
  ],
  states: [
    { id: "stand", clipId: "idle" },
    { id: "move", blendSpaceId: "bot_speed" },
  ],
  transitions: [
    { id: "start", from: "stand", to: "move", conditions: [{ parameter: "speed", op: ">", value: 0.1 }], blendSeconds: 0.2 },
    { id: "stop", from: "move", to: "stand", conditions: [{ parameter: "speed", op: "<=", value: 0.1 }], blendSeconds: 0.2 },
  ],
};

function entity(entities: RuntimeEntityState[], id: string): RuntimeEntityState {
  const found = entities.find((e) => e.entityId === id);
  assert.ok(found, `entity ${id} must be in the query result`);
  return found;
}

function weightOf(
  actions: Array<{ clip: string; weight: number; role: string }> | undefined,
  role: string,
  clip?: string,
): number {
  return (actions ?? [])
    .filter((a) => a.role === role && (clip === undefined || a.clip === clip))
    .reduce((sum, a) => sum + a.weight, 0);
}

test(
  "Animation graph states that play a blend space (Electron)",
  { skip: !canRunRealElectronTests(), timeout: 120_000 },
  async (t) => {
    await t.test("crossfades clip -> blend space -> clip driven by a graph parameter", async () => {
      const host = createHost();
      const probe = new KinetraRuntimeProbe({
        host,
        project: () => createBlendSpaceProject(),
        initialRevision: 0,
        assets: arenaAssets,
        closeOnStop: false,
      });

      try {
        await probe.start(SCENE_ID, 811);

        const init = await host.initAnimationGraph(ENTITY_BLENDED, GRAPH);
        assert.equal(init.success, true, init.error);
        const idle = entity(init.entities, ENTITY_BLENDED).model?.animation;
        assert.equal(idle?.graph?.state, "stand");
        assert.equal(idle?.blendSpace, undefined);

        // Invalid graph: structured diagnostic, entity keeps playing.
        const rejected = await host.initAnimationGraph(ENTITY_REFERENCE, {
          ...GRAPH,
          states: [{ id: "stand", clipId: "idle" }, { id: "move", blendSpaceId: "missing_space" }],
        });
        assert.equal(rejected.success, false);

        const started = await host.setAnimationGraphParameter(ENTITY_BLENDED, "speed", 1.5);
        assert.equal(started.success, true, started.error);
        const t0 = entity(started.entities, ENTITY_BLENDED).model?.animation;
        assert.equal(t0?.graph?.state, "move");
        assert.equal(t0?.graph?.transitioning, true);
        assert.equal(t0?.graph?.blendProgress, 0);
        assert.equal(t0?.blendSpace?.groupWeight, 0);

        // 6 frames at 60 Hz = 0.1 s of the 0.2 s fade.
        const mid = await host.step(6, 1 / 60);
        const half = entity(mid.entities, ENTITY_BLENDED).model?.animation;
        assert.ok(Math.abs((half?.graph?.blendProgress ?? -1) - 0.5) < 1e-6, `blendProgress ${half?.graph?.blendProgress}`);
        assert.ok(Math.abs((half?.blendSpace?.groupWeight ?? -1) - 0.5) < 1e-6);
        assert.ok(Math.abs(weightOf(half?.actions, "outgoing", "idle") - 0.5) < 1e-6);
        assert.ok(Math.abs(weightOf(half?.actions, "incoming") - 0.5) < 1e-6);
        assert.ok(Math.abs(weightOf(half?.actions, "incoming", "walk") - 0.25) < 1e-6);
        assert.ok(Math.abs(weightOf(half?.actions, "incoming", "attack") - 0.25) < 1e-6);

        const frame = await probe.captureFrame();
        assert.ok(frame.byteLength > 1000, "mid-crossfade frame renders");

        const done = await host.step(12, 1 / 60);
        const full = entity(done.entities, ENTITY_BLENDED).model?.animation;
        assert.equal(full?.graph?.transitioning, false);
        assert.equal(full?.graph?.blendProgress, 1);
        assert.equal(full?.blendSpace?.groupWeight, 1);
        assert.ok(full?.actions?.every((a) => a.role === "blend"));

        // The parameter keeps driving the weights; the dedicated input API is refused.
        const faster = await host.setAnimationGraphParameter(ENTITY_BLENDED, "speed", 2);
        const attacking = entity(faster.entities, ENTITY_BLENDED).model?.animation;
        assert.deepEqual(attacking?.blendSpace?.input, { speed: 2 });
        assert.equal(attacking?.activeClip, "attack");
        const refused = await host.setBlendSpaceInput(ENTITY_BLENDED, { speed: 1 });
        assert.equal(refused.success, false);
        assert.equal(refused.code, "anim.blendSpace.graphDriven");

        // Back to the idle clip: the space fades out as one group.
        const stopping = await host.setAnimationGraphParameter(ENTITY_BLENDED, "speed", 0);
        const out0 = entity(stopping.entities, ENTITY_BLENDED).model?.animation;
        assert.equal(out0?.graph?.state, "stand");
        assert.equal(out0?.graph?.transitioning, true);
        assert.equal(out0?.blendSpace, undefined);
        assert.ok(Math.abs(weightOf(out0?.actions, "outgoing") - 1) < 1e-6);
        const outMid = await host.step(6, 1 / 60);
        const out1 = entity(outMid.entities, ENTITY_BLENDED).model?.animation;
        assert.ok(Math.abs(weightOf(out1?.actions, "outgoing") - 0.5) < 1e-6);
        assert.ok(Math.abs(weightOf(out1?.actions, "incoming", "idle") - 0.5) < 1e-6);
        const outDone = await host.step(12, 1 / 60);
        const settled = entity(outDone.entities, ENTITY_BLENDED).model?.animation;
        assert.equal(settled?.graph?.transitioning, false);
        assert.deepEqual(settled?.actions, [{ clip: "idle", weight: 1, role: "active" }]);

        const logs = await probe.logs();
        assert.ok(logs.some((l) => l.message === "animation.graph.initFailed"));
        assert.ok(!logs.some((l) => l.message === "model.loadFailed"));
      } finally {
        await probe.close();
      }
    });
  },
);
