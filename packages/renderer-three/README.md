# @kinetra/renderer-three

Three.js rendering adapter with WebGL2/WebGPU backend capability hidden behind Kinetra runtime contracts.

Three.js is a **projection** here, never the source of truth: the authored `ProjectDocument` (see `@kinetra/project-model`) is turned into a Three.js scene by `ThreeSceneRuntime`, and gameplay code reads and writes entities through the runtime/command layers, not by poking Three objects. The package runs headless in Node (no canvas needed) for everything except `WebGL2Backend`.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `ThreeSceneRuntime` | class | `ThreeSceneRuntime.instantiate(project, sceneId)` builds the object graph (cameras, lights, `Primitive` box/sphere/plane meshes, `Transform`, parenting). `instantiateAsync(project, sceneId, { assetResolver })` also loads `Model` assets. Lookups: `getObject`, `objects()`, `getModelMetadata`, `models()`, `getInstance`, `getSceneMetrics`. `dispose()` tears everything down. |
| `AssetResolver` | interface | `resolve(assetId)` → `Uint8Array \| ArrayBuffer \| string \| undefined`, optional `getFingerprint(assetId)`. The only way the renderer obtains asset bytes. |
| `ModelTemplateCache`, `ModelAssetTemplate`, `ModelInstance` | classes | One parsed glTF template per asset id, cloned per entity with an independent skeleton; geometry, materials and textures are shared and reference-counted. `invalidate`/`resolveNewTemplate` support hot reload. |
| `createRuntimeGltfLoader`, `RUNTIME_GLTF_DECODERS` | function / const | The glTF loader with the Meshopt decoder wired in. Draco and KTX2 are **off** (the packaged player carries no decoders); `@kinetra/asset-pipeline`'s compression policy mirrors this and a test keeps the two in sync. |
| `runtime.loadModels`, `attachModel`, `detachModel`, `reloadAsset` | methods | Model lifecycle. Async loads that were superseded (detach, re-attach, dispose) are discarded instead of installing an orphan instance. `reloadAsset` swaps in a re-imported asset and reports the affected entities. |
| `runtime.playAnimation`, `crossfadeAnimation`, `stopAnimation`, `registerAnimationClip`, `updateAnimation(dt)` | methods | Clip playback on the entity's `AnimationMixer`. A non-finite or non-positive `dt` is ignored. |
| `initAnimationGraph`, `setAnimationGraphParameter`, `triggerAnimationGraph`, `evaluateAnimationGraph` | methods | Runtime for `@kinetra/animation` state-machine graphs. |
| `playBlendSpace`, `setBlendSpaceInput`, `getBlendSpaceState`, `BlendSpacePlayback` | methods / class | 1D/2D locomotion blend spaces (see `packages/animation/README.md`). |
| `configureRootMotion`, `sampleRootMotion`, `recordRootMotionResult` | methods | Root-motion extraction: the runtime reports the per-step delta; the caller applies it. |
| `setMorphWeights`, `clearMorphWeights`, `MorphTargetController` | methods / class | Named morph-target weights with structured diagnostics for unknown names. |
| `setIkChains`, `setIkTarget`, `clearIkTarget`, `IkController` | methods / class | Two-bone IK applied after the mixer update; poses are restored when a target is cleared and after a hot reimport. |
| `setAnimationEvents`, `onAnimationEvent`, `getAnimationEventLog`, `clearAnimationEventLog`, `getAnimationEventStats`, `getAnimationEventDiagnostics`, `AnimationEventDispatcher`, `MAX_ANIMATION_EVENT_LOG` | methods / class | Clip animation events (#90): plain-data events from `@kinetra/animation` are fired from real mixer playback, once per crossing and independent of step size. Reported with the entity id and a monotonic `sequence`; the log is bounded (256) and listener exceptions are isolated. |
| `WebGL2Backend` (`RenderBackend`) | class | The only canvas-bound piece: `initialize(canvas)`, `render(scene, camera)`, `resize(w, h, dpr)`, `getStats()`, `dispose()`. |

Unsupported `Camera.type`, `Light.kind` or `Primitive.kind` values throw with the entity id in the message instead of rendering nothing.

Animation event limits (also in `docs/architecture/ANIMATION.md`): only clip actions (active and outgoing) fire events, blend-space sample actions do not yet, ping-pong loops fire nothing and record one diagnostic, and events fire regardless of the action weight. A discontinuity (restart, manual time change, start delay) re-synchronizes without firing the skipped range.

## Example

Instantiate a scene, load one model for two entities and play a clip. Both entities share one parsed template; each gets its own instance.

```ts doc-check
import assert from "node:assert/strict";
import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ThreeSceneRuntime, type AssetResolver } from "@kinetra/renderer-three";

const sceneId = stableId("scene", "demo");
const crateA = stableId("entity", "crate_a");
const crateB = stableId("entity", "crate_b");
const floor = stableId("entity", "floor");

const project: ProjectDocument = {
  schemaVersion: 1,
  projectId: stableId("project", "demo"),
  name: "Renderer demo",
  scenes: [
    {
      id: sceneId,
      name: "Demo",
      entities: [
        {
          id: crateA,
          name: "Crate A",
          components: { Transform: { position: [-2, 0, 0] }, Model: { assetId: "asset_crate" } },
        },
        {
          id: crateB,
          name: "Crate B",
          components: { Transform: { position: [2, 0, 0] }, Model: { assetId: "asset_crate" } },
        },
        {
          id: floor,
          name: "Floor",
          components: { Primitive: { kind: "plane", width: 10, height: 10, color: "#333333" } },
        },
      ],
    },
  ],
};

const glb = await createSyntheticGlb({
  animation: { clipName: "Lift", duration: 1, property: "translation", from: [0, 0, 0], to: [0, 2, 0] },
});
const resolver: AssetResolver = {
  resolve: (assetId) => (assetId === "asset_crate" ? glb : undefined),
};

const runtime = await ThreeSceneRuntime.instantiateAsync(project, sceneId, { assetResolver: resolver });

assert.equal(runtime.getModelMetadata(crateA)?.loaded, true);
assert.equal(runtime.instanceCount, 2);
assert.equal(runtime.assetTemplateParseCount, 1, "one parse serves both entities");
assert.deepEqual(runtime.getObject(crateB)?.position.toArray(), [2, 0, 0]);

assert.equal(runtime.playAnimation(crateA, "Lift"), true);
runtime.updateAnimation(0.5);

// An asset the resolver does not know about is a recorded error, not an exception.
const missing = await runtime.attachModel(floor, "asset_missing", resolver);
assert.equal(missing.success, false);

runtime.dispose();
assert.equal(runtime.disposed, true);
```

Animation events are plain data validated by `setAnimationEvents`, which never throws: invalid entries are dropped and returned as diagnostics.

```ts doc-check
import assert from "node:assert/strict";
import { createSyntheticCharacterGlb } from "@kinetra/asset-pipeline";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { ThreeSceneRuntime } from "@kinetra/renderer-three";

const sceneId = stableId("scene", "events");
const hero = stableId("entity", "events_hero");
const project: ProjectDocument = {
  schemaVersion: 1,
  projectId: stableId("project", "events"),
  name: "Animation events",
  scenes: [
    {
      id: sceneId,
      name: "Events",
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
const runtime = await ThreeSceneRuntime.instantiateAsync(project, sceneId, {
  assetResolver: { resolve: (assetId) => (assetId === "bot" ? glb : undefined) },
});
const walk = runtime.getModelMetadata(hero)?.animation?.clips.find((clip) => clip.name === "walk");
assert.ok(walk && walk.duration > 0);

const heard: string[] = [];
const unsubscribe = runtime.onAnimationEvent((event) => heard.push(`${event.entityId}:${event.name}`));
const result = runtime.setAnimationEvents([
  { clip: "walk", time: walk.duration / 2, name: "footstep", payload: { foot: "left" } },
]);
assert.deepEqual(result.diagnostics, []);

assert.equal(runtime.playAnimation(hero, "walk", { loop: true }), true);
// Two full loops in small steps: the event fires once per loop, whatever the step size.
for (let i = 0; i < Math.round((walk.duration * 2 - 0.001) * 30); i++) runtime.updateAnimation(1 / 30);

const log = runtime.getAnimationEventLog();
assert.equal(log.length, 2);
assert.deepEqual(heard, [`${hero}:footstep`, `${hero}:footstep`]);
assert.deepEqual(
  log.map((event) => event.sequence),
  [1, 2],
);
unsubscribe();
runtime.dispose();
```

## Proof level

| Capability | Proof |
| --- | --- |
| Scene projection, parenting, disposal | `runtime-three.test.ts` |
| Template sharing, ref counts, independent skeletons | `multi-instance.test.ts` |
| Hot reload / `reloadAsset` | `reload.test.ts`; end to end in the player via `real-hot-reimport` and `real-blender-hot-reimport` (verification package) |
| Blend space, graph + blend space | `blend-space.test.ts`, `graph-blend-space.test.ts` |
| Morph targets, IK | `morph.test.ts`, `ik.test.ts` |
| Compression: a real Meshopt GLB decodes, and the capability table matches the asset pipeline's | `compressed-gltf.test.ts` (Draco and KTX2 decoding are not implemented) |
| Animation events from mixer playback (loop, once, crossfade, restart, bounded log) | `animation-events.test.ts` |
| Step guards (non-finite deltas), async load races | `step-guards.test.ts`, `async-races.test.ts` |
| Real GPU rendering | Not unit-tested here; screenshots and visual checks run in the Electron player (`real-visual-verification` in `@kinetra/verification`). WebGPU is not implemented. |

Run the unit tests with `pnpm --filter @kinetra/renderer-three test`.
