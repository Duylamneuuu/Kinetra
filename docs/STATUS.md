# Implementation status

**Snapshot:** 2026-09-19, updated through PR #308 (2026-10-11); per-PR detail and verification evidence are in the CHANGELOG  
**Authoritative base:** `main`. Merged change history: [`CHANGELOG.md`](../CHANGELOG.md).

Legend:

- **DONE** — acceptance gate was previously completed/closed.
- **CORE MERGED** — useful tested core is on `main`, but the full phase acceptance gate is not complete.
- **WIP** — experimental code exists outside `main`; do not treat as accepted.
- **NOT STARTED / PLACEHOLDER** — docs/folders may exist, but the phase is not proven.

| Phase | Status | What is actually true |
|---|---|---|
| P0 project model | DONE | Versioned text project model, stable IDs, deterministic serialization/migration baseline. |
| P0 command/query bus | DONE | Typed mutation path, revisions/transactions/diff/undo baseline established. |
| P0 Three.js projection | DONE | Minimal runtime projection exists without making Three.js authoritative. |
| P0 license guardrails | DONE | License policy/checking baseline exists. |
| P1 Windows packaging spike | DONE | Electron/Vite Windows packaging and smoke path were proven early. |
| Linux x64 packaged player | PACKAGED SLICE PROVEN | Portable Linux x64 `KinetraGame` (`package:linux`, `smoke:linux:packaged`) uses the same Electron runtime bridge as Windows. Proof is the packaged binary, not dev Electron: `hostInfo.platform === "linux"`, `arch === "x64"`, `isPackaged === true`, Arena semantic input, real PNG capture, save/load across a packaged-process restart, and clean teardown. |
| P2 AI-native runtime bridge | CORE PROVEN | Real Electron/Three.js player runtime bridge with named pipe IPC, project instantiation, live entity query, semantic input injection, structured logs, and real PNG capture verified on Windows. Linux cloud smoke proven via cross-platform stdio bridge under xvfb (`pnpm --filter @kinetra/player smoke:linux` + Linux CI): ping/hostInfo/start/query/step/injectInput/captureFrame/stop against Kinetra Arena with valid-PNG and zero-leak teardown proof. Bridge lines that are not valid requests (bad JSON, non-object, missing/non-string `id` or `method`) get a structured failure response (`code` = `BRIDGE_INVALID_JSON`/`_REQUEST`/`_ID`/`_METHOD`, `id` echoed when it was a string, else `null`) instead of being dropped; parsing is the pure `apps/player/electron/bridge-protocol.ts`, unit-tested in `apps/player/test/bridge-protocol.test.ts` (11 tests, plain Node). Not yet covered by a real-Electron test. |
| P3 observer editor | HEADLESS MODEL SLICE ONLY | `@kinetra/editor` (`apps/editor`) has the UI-independent core: `buildHierarchy` (pure, total depth-first hierarchy rows that never hide a detached/cyclic entity) and `EditorSession` (reads snapshots from a `CommandBus`; every edit is a typed command sent to that same bus; editor-scoped undo/redo that refuses to rewind another client's work with `UNDO_CONFLICT`; selection that drops deleted entities). Unit-tested, including a parity test that the same edits through the editor and through `KinetraAgentService` give identical changes, project snapshot and event log. There is no viewport, window or Electron shell yet: no UI exists. PR #22 remains the old UX reference. |
| P4 Blender/asset pipeline | BLENDER HOT-REIMPORT GATE PROVEN | Complete authoring-to-runtime asset loop proven: headless Blender source (.blend) modification changes binary hash, detected by content-hash watcher (`SourceAssetWatcher`), driving deterministic reimport via engine-owned `BlenderGlbImporter` and `AssetReimportService`. Transitive dependency rebuild executes in strict topological order (`dependentsInRebuildOrder`) recomputing cascading fingerprints (`importFingerprint`), isolating unaffected assets, and handling partial failure (failed node halts downstream dependents as blocked while root and unaffected nodes remain published). High-level `AssetHotReloadCoordinator` wires watcher -> reimport -> dependency rebuild -> runtime publication -> live reload (`ThreeSceneRuntime.reloadAsset`) without manual glue. Proven in real Electron runtime without process restart, preserving entity IDs, world transforms, multi-instance model lifecycles, and WebGL rendering with valid PNG capture. Blender remains strictly an authoring DCC dependency with zero footprint in packaged binaries (`KinetraGame.exe`). Remaining non-gate asset improvements: thumbnails, offline Meshopt/Draco/KTX2 encode step, Draco/KTX2 runtime decoders, large-project worker scheduling. |
| P5 animation | SAFE MULTI-INSTANCE SKINNED MODEL LIFECYCLE PROVEN | Reusable parsed asset template cache (`ModelTemplateCache`), ref-counted GPU resource sharing (geometry/textures), isolated instance cloning (`SkeletonUtils.clone()`) with independent skeletons, bones, `AnimationMixer`s, animation graphs, and root-motion sessions, per-instance cloned materials preventing leaks, dynamic attach/detach (`model.detach`/`model.attach`), safe disposal on `refCount === 0`, and zero-leak reload. Text-backed schema-versioned animation graph, deterministic crossfading, real external humanoid retargeting with persistent disk cache reuse, and deterministic root-motion extraction driving authoritative Rapier kinematic character movement without visual double-motion. Verified via real Electron acceptance suite and packaged Windows binary (`KinetraGame.exe`). 1D/2D locomotion blend spaces play in the runtime with phase sync (unit + real Electron proof); morph targets (blend shapes) are driven by semantic name through `animation.setMorphWeights`/`animation.clearMorphWeights` (unit + real Electron proof); pure IK solver contract (two-bone + FABRIK) is unit-tested; graph states can play blend spaces with crossfades in and out (unit + real Electron proof); blend-space root motion remains unfinished. |
| P6 complete-game contracts | RUNTIME SLICES PROVEN | P6 gameplay script/input + save/load + desktop file storage + audio runtime slices proven: ScriptHost lifecycle (onCreate/onStart/onUpdate/onStop/onDestroy), InputRouter semantic action routing (player.moveRight, player.jump), deterministic frame ordering, truthful structured observation (entity.gameplay), versioned save/load persistence (@kinetra/save-state) with atomic restoration and real file-backed desktop storage (multi-process restart, atomic write, path traversal protection, corrupt save resilience), hierarchical audio mixer (@kinetra/audio) with truthful gain/mute propagation, Web Audio decoding/playback via assetId, and AcceptanceRunner proofs verified in live Electron. Complete game shell contracts proven including Main Menu, HUD, Pause menu, audio/input settings, gameplay loop, save/load, and combat progression across dev Electron and packaged binaries. |
| P7 physics/navigation/perf | DETERMINISTIC PHYSICS/NAVIGATION + PERFORMANCE BUDGET SLICE PROVEN | Rapier physics and Recast navigation baselines proven in real Electron runtime via AcceptanceRunner: deterministic fixed-step simulation, gravity fall, floor collision, kinematic character controller clipping, navmesh generation, pathfinding (findPath), agent navigation, and live transform sync. Runtime performance telemetry and budget gate proven: engine-owned RuntimePerformanceEvidence (sample count, warmup, percentiles p50/p95/p99/max for frame/simulation/render, authoritative Three.js renderer metrics, scene metrics, physics stats), performance.sample bridge command, assert.performanceBudget acceptance step, machine-readable performance.budgetExceeded violations, normal shipping performant renderer configuration (preserveDrawingBuffer: false), deliberate draw-call regression proof, resource growth lifecycle proof, multi-instance template parse reuse proof, and packaged Windows/Linux validation. |
| P8 verification | PERCEPTUAL + PERFORMANCE ACCEPTANCE GATES PROVEN | P8 MCP acceptance execution + packaged-runtime acceptance + perceptual visual verification + performance telemetry budget gate proven: test.runAcceptance tool, typed AcceptanceManifest input, semantic target (runtime vs packaged), engine-owned packaged executable resolution (KinetraGame.exe), truthful process evidence observations (hostInfo.isPackaged, execPath, renderer config, performance telemetry, budget violations), machine-readable pass/fail reports with failed steps/failureReason, clean zero-leak teardown across repeated invocations, engine-owned deterministic perceptual visual analysis (VisualFrameEvidence, 64-bit dHash perceptual hash, Sobel edge density, Shannon entropy, blank frame detection, configurable perceptual comparison), additive visual steps (capture.frame, assert.visualNotBlank, assert.visualSimilarity, assert.visualDifference, critique.visual), direct WebGL canvas frame capture with explicit captureMode ("performance" vs "visual"), controlled regression catch, provider-neutral vision critique provider contract (@internal FakeVisualCritiqueProvider), performance.sample and assert.performanceBudget steps, and full packaged Windows/Linux smoke integration. Authenticated live multimodal AI critique and full complete-game shipping acceptance manifest remain. |
| P10 reference game | COMBAT FEEL & PROGRESSION PROVEN | Reference game vertical slice ("Kinetra Arena") expanded with deterministic combat feel, enemy telegraphing, hurt reactions, extraction unlock progression, and run summary statistics. 7-scenario progression acceptance suite (`real-combat-progression.test.ts`) passing against dev Electron and packaged Windows binary (`KinetraGame.exe`). |
| AI asset production | ORCHESTRATION BOUNDARY & INGESTION PROVEN | Provider-neutral Scenario orchestration boundary documented truthfully with clear separation from runtime player; Kinetra-owned orchestration skill (`.agents/skills/kinetra-scenario-asset/SKILL.md`); ingestion pipeline with validation, normalization, sha256 content hashing, stable assetId, and provider-neutral AssetProvenance metadata; deterministic synthetic energy-crate prop fixture (`createSyntheticPropGlb`); verification via real Electron runtime, command-bus authoring, structured query, PNG render, error handling, and clean teardown. Authenticated live Scenario model_run → download → Kinetra import execution is not yet proven. |

## Merged subsystem notes

### Asset pipeline

What has meaningful proof:
- deterministic source/import fingerprints;
- asset dependency invalidation;
- structured diagnostics;
- GLB validation;
- Blender headless fixture generation/export through CI;
- GLB parse/normalization with permissive core dependencies;
- programmatic synthetic GLB fixture generation (`createSyntheticGlb`);
- narrow `AssetResolver` contract resolving Kinetra-owned `assetId`;
- real Electron/Three.js `GLTFLoader` projection into disposable scene objects;
- transform inheritance from entity `Transform` component;
- truthful structured runtime query (`entity.model: { assetId, loaded, meshCount, nodeCount, bounds, error }`);
- structured error log `model.loadFailed` on unresolvable assets;
- recursive disposal of geometry, material, and texture resources;
- end-to-end verification via `AcceptanceRunner` and real frame capture;
- content-hash change detection via `SourceAssetWatcher` handling debouncing, touches, and atomic replaces;
- deterministic `AssetReimportService` with NOOP detection, GLB validation, atomic file replacement, and rollback on failure;
- transitive dependency graph invalidation (`AssetDatabase.invalidationSet`);
- topological dependency rebuild order (`AssetDatabase.dependentsInRebuildOrder`, `rebuildOrder`) following dependency arrows rather than lexical sorting;
- cascading dependency fingerprint propagation via `importFingerprint()`;
- partial failure semantics with structured `DependencyRebuildResult` (`rebuilt`, `failed`, `blocked`, `unaffected`);
- engine-owned `BlenderGlbImporter` executing headless Blender export into staging GLBs with validation;
- headless `.blend` fixture modification (`modify_fixture.py`) changing binary content hash;
- high-level `AssetHotReloadCoordinator` wiring watcher -> reimport -> dependency rebuild -> runtime asset update -> live entity reload without manual glue;
- single-transaction coalescing and touch/NOOP filtering;
- live Electron hot reload swapping live entity instances without process restart, preserving entity IDs and transforms;
- multi-instance reload proof sharing single template parse across multiple entities;
- failure rollback leaving valid prior instances intact upon corrupt reimport attempts, and recovering cleanly on valid repairs;
- verified CI headless Blender export, modification, and reimport in `.github/workflows/blender-pipeline.yml`.

- GLB compression policy (`inspectGlbCompression`, `evaluateCompressionPolicy`, `checkGlbCompression` in `@kinetra/asset-pipeline`): reads only the GLB JSON chunk, never throws, reports Meshopt/Draco/KTX2 usage, validates `EXT_meshopt_compression` fields, flags required extensions the runtime loader does not know, flags compression used but not declared, and advises an offline Meshopt pass for large uncompressed geometry. Proof level: 21 pure unit tests;
- the runtime glTF loader (`createRuntimeGltfLoader` in `@kinetra/renderer-three`) decodes `EXT_meshopt_compression`: a real GLB compressed with the meshoptimizer encoder (vertex and index buffers) loads to the exact source positions and indices, and a stock `GLTFLoader` is shown to reject the same file. `RUNTIME_DECODER_CAPABILITIES` (asset-pipeline) and `RUNTIME_GLTF_DECODERS` (renderer) are kept equal by a test. Proof level: Node unit tests. Not proven: Meshopt-compressed assets inside the packaged Electron player.

Remaining non-gate enhancements:
- thumbnails/previews;
- an offline encode step that actually applies Meshopt (policy and runtime decode exist; no encoder is run by the pipeline yet);
- Draco decoder (needs decoder files shipped with the player; currently reported as `asset.compression.draco.runtimeUnsupported`);
- KTX2/Basis transcoder (same; `asset.compression.ktx2.runtimeUnsupported`);
- large-project import scheduling/performance.

### AI asset production (Scenario)

What has meaningful proof:
- external Scenario MCP endpoint boundary (`https://mcp.scenario.com/mcp`) documented truthfully with clear separation from runtime player;
- Kinetra orchestration skill (`.agents/skills/kinetra-scenario-asset/SKILL.md`) providing end-to-end guidance, prompt generation, deterministic dry-run Creative Units estimation, and verification instructions;
- asset pipeline metadata extension (`AssetProvenance`) tracking provider, generator, model, prompt, creative units cost, and license;
- asset validation policy (`validateAssetRecord`) rejecting negative costs, invalid provider keys, synthetic fixture provider conflicts, and out-of-bounds prop dimensions (> 50m);
- programmatic prop generator (`createSyntheticPropGlb`) producing deterministic multi-mesh GLB props with metallic frames and emissive cores;
- canonical static prop fixture (`examples/reference-game/assets/props/energy-crate.glb` & `energy-crate.asset.json`) with truthful Kinetra synthetic provenance;
- command-bus authoring into project documents adhering to schema validation;
- real Electron runtime asset resolution via `AssetResolver`, Three.js projection, and structured model query (`state.byName.EnergyCrate.model: { loaded, assetId, meshCount, bounds }`);
- real PNG visual render capture;
- deliberate failure testing for unresolvable assets producing structured error logs (`model.loadFailed`) without crashing Electron;
- clean, leak-free teardown of runtime and host.

What remains:
- a real authenticated Scenario model_run → download → Kinetra import execution (live external generation);
- automated Scenario webhook ingestion when external credentials are present;
- texture bake optimization and LOD generation;
- sprite and audio generator integration.


### Animation

What has meaningful proof:
- semantic humanoid bone mapping;
- skeleton signatures;
- source->target retarget plan;
- retarget cache key;
- root-motion extraction policy;
- text-backed graph/state-machine semantics;
- programmatic synthetic animated GLB fixture generation (`createSyntheticAnimatedGlb`);
- programmatic synthetic rigged character GLB fixture generation (`createSyntheticCharacterGlb`) with real `SkinnedMesh`, 7-bone hierarchy (`Hips`, `Spine`, `Head`, `LeftArm`, `RightArm`, `LeftLeg`, `RightLeg`), and 6 combat clips (`idle`, `walk`, `telegraph`, `attack`, `hurt`, `defeat`);
- canonical rigged character fixture (`examples/reference-game/assets/characters/enemy-bot.glb` & `enemy-bot.asset.json`) with truthful Kinetra synthetic fixture provenance metadata;
- GLTF animation clip extraction via Three.js `GLTFLoader` in the Electron player runtime;
- Three.js `SkinnedMesh` and `Skeleton` detection, populating structured runtime state `entity.model.skinnedMeshCount` and `entity.model.hasSkin`;
- encapsulated `THREE.AnimationMixer` management in `ThreeSceneRuntime` behind semantic methods (`playAnimation`, `stopAnimation`, `updateAnimation`);
- recursive skeleton and mixer disposal (`child.skeleton.dispose()`, `mixer.stopAllAction()`, `mixer.uncacheRoot()`) on model unload and scene cleanup;
- engine-owned semantic animation layer exposed to scripts via `context.animation` (`play`, `stop`, `activeClip`, `playing`);
- truthful structured observation via `entity.gameplay.animation: { activeClip, playing, speed }`;
- authoritative gameplay and physics separation: visual animation pose only, Rapier owns character position, independent combat reaction and damage timing;
- deterministic synchronization between `ArenaEnemyController` combat state machine (`chasing`, `telegraph`, `attacking`, `hurt`, `defeated`) and character animation clips;
- semantic command dispatch (`animation.play`, `animation.stop`) over named pipe bridge;
- deterministic simulation advancement via `runtime.step` updating mixer and synchronizing internal node transforms;
- truthful structured runtime state exposing `entity.model.animation` (`clips`, `activeClip`, `playing`, `time`, `duration`) and `entity.model.nodes` (`name`, `position`);
- structured error log `animation.playFailed` on invalid clip requests without runtime crash;
- resource cleanup and zero-leak teardown on scene stop and restart;
- real AcceptanceRunner proof with real PNG frame capture in live Electron;
- full 10-scenario real Electron verification suite (`real-character-animation.test.ts`) passing against dev Electron and packaged Windows binary (`KinetraGame.exe`);
- ingestion of real external humanoid/skinned GLB (`CesiumMan.glb`, CC-BY 4.0, Khronos Group / Cesium) with truthful provenance in `cesium-man.asset.json` and license policy tracking (`allowedWithNotice`);
- skeleton inspection via `@gltf-transform/core` (`inspectSkeletonFromGlb`) discovering source joints (`Skeleton_torso_joint_1`, etc.) and target joints (`Hips`, `Spine`, etc.);
- semantic humanoid bone mapping (`sourceBone -> semanticBone -> targetBone`) bridging distinct artist naming conventions;
- real transform retarget baking (`bakeRetargetedClip`) generating target-specific `THREE.AnimationClip` referencing target skeleton bone names with normalized delta quaternions relative to rest poses;
- explicit hips translation policy (`"ignore"` by default for clean separation from Rapier physics);
- deterministic retarget cache key (`computeRetargetCacheKey`) sensitive to sourceAssetHash, sourceClipId, source/target skeleton signatures, semantic mapping, settings, and retargetVersion;
- engine-owned persistent baked-retarget cache (`RetargetBakeCache`, `FileRetargetCacheStorage`) wrapping Three.js `AnimationClip` in versioned record (`RetargetCacheRecord`);
- multi-process cache reuse across independent Electron processes (Process A MISS/bake/persist -> Fresh Process B HIT/load/playback) without recomputing retarget transforms;
- deterministic cache invalidation on changed source asset hash, semantic mapping, target skeleton, or retarget settings/version;
- resilient recovery from corrupted cache artifacts and stale schema versions reporting structured `regenerationReason`;
- structured cache observation (`cacheKey`, `cacheHit`, `cachePath`/`cacheIdentity`, `bakedClipName`, `trackCount`, `regenerationReason`) without exposing arbitrary local filesystem paths to project data;
- structured diagnostics for missing/incompatible bones with actionable remediation hints (`retarget.bone.missing-required`, `retarget.clip.no-usable-tracks`);
- dynamic runtime clip registration (`ThreeSceneRuntime.registerAnimationClip`) and IPC handler (`animation.registerClip`);
- live Electron runtime playback of baked retargeted clip on target SkinnedMesh (`EnemyBot`);
- deterministic simulation stepping advancing retargeted clip mixer time and updating target bone rotations;
- runtime state observation exposing `retargetSource` and `retargetCacheKey`;
- real WebGL frame capture producing valid PNG during retargeted animation playback;
- scene reload/restart clearing stale mixer state and allowing clean re-playback without leaks;
- full 12-scenario real Electron verification suite (`real-humanoid-retarget.test.ts`) passing against dev Electron and packaged Windows binary (`KinetraGame.exe`);
- text-backed schema-versioned animation graph (`AnimationGraphDefinition`, `AnimationGraphMachine`, schemaVersion: 1) supporting typed parameters (`bool`, `number`, `trigger`), conditions, priorities, wildcard transitions (`from: "*"`), and transition `blendSeconds`;
- engine-owned runtime animator session (`EntityAnimatorSession`, `AnimatorBlendSession`) on `ThreeSceneRuntime`;
- deterministic concurrent crossfading (`crossfadeAnimation`, `updateAnimation`) shifting weights smoothly across `runtime.step(fixedDeltaSeconds)` when `blendSeconds > 0`, and immediate switch when `blendSeconds == 0`;
- mid-blend interruption policy stopping superseded outgoing actions immediately with zero weight and demoting active action to outgoing without action leakage;
- observable runtime graph state (`model.animation.graph = { state, previousState, transitionId, transitioning, blendSeconds, blendElapsed, blendProgress }`) and concurrent weighted actions (`model.animation.actions = [{ clip, weight, role }]`);
- negative proofs emitting structured diagnostics and errors for invalid graphs, missing clips, unknown parameters, invalid parameter types, and unknown triggers without crashing the runtime;
- transparent resolution of retargeted clips (`${name}_retargeted`) in graph states and crossfades;
- reference game integration where `ARENA_ENEMY_ANIMATION_GRAPH` drives EnemyBot combat lifecycle (idle, walk, telegraph, attack, hurt, defeat) without altering damage timing, reaction windows, or combat logic;
- comprehensive real Electron verification suite (`packages/verification/test/real-animation-graph.test.ts`) passing all 8 scenarios with valid PNG capture during active blend;
- truthful source inspection (`inspectClipRootMotion`) correctly classifying CesiumMan as in-place (~4mm net XZ over 2.0s) and RootMotionBot as locomotion (~1.6m forward per loop);
- deterministic root motion extraction (`extractRootMotionFromClip`, `computeRootMotionStepDelta`) with partition invariance and exact loop wrap without position spikes or teleports;
- visual skeleton in-place stripping (`stripVisualRootDisplacement`) zeroing X and Z translations while preserving dynamic pelvic Y bobbing, preventing double motion;
- authoritative physics resolution where animation extracts desired motion intent, PlayerRuntimeController applies it through `physics.moveCharacter`, and Rapier character controller remains 100% authoritative over entity world transform;
- real collision resolution with solid obstacles clipping displacement (`appliedDelta < requestedDelta`, `collisionClipped == true`, positive `blockedDelta`) and preventing tunneling;
- animation graph crossfade ownership where the incoming state owns motion intent (walk -> idle halts forward progress smoothly; walk -> hurt immediately clears root motion ownership);
- structured observation via `entity.model.animation.rootMotion` and `entity.gameplay.rootMotion` exposing `enabled`, `mode`, `activeClip`, `accumulatedDistance`, `requestedDelta`, `appliedDelta`, `blockedDelta`, and `collisionClipped`;
- scene restart resetting accumulators and positions to origin;
- 7-scenario real Electron verification suite (`packages/verification/test/real-root-motion.test.ts`) passing against dev Electron and packaged Windows binary (`KinetraGame.exe`);
- 100% pass across full workspace check (`pnpm check`) and packaged Windows binary (`smoke:win` on `KinetraGame.exe`).
- reusable parsed asset template cache (`ModelTemplateCache`) deduplicating concurrent GLB loads so identical `assetId` parses only once (`assetTemplateParseCount == 1`);
- safe skeleton cloning via `SkeletonUtils.clone()` ensuring each entity instance gets its own independent `Skeleton` with separate `Bone` object references, distinct parent transforms, and independent bone matrices;
- per-instance `AnimationMixer` instances and independent animation graph sessions running on the same asset without cross-talk or mixer bleeding;
- per-instance material cloning (`material.clone()`) allowing independent color/opacity mutations while safely sharing underlying `BufferGeometry` and textures;
- reference-counted resource lifecycle tracking (`refCount`) where GPU geometries and textures are kept alive as long as `refCount > 0` and properly disposed only when all instances of an asset are detached/unloaded (`refCount === 0`);
- dynamic model detachment (`model.detach`) and reattachment/live reload (`model.attach`) reusing existing cached templates without reparsing or leaking GPU resources;
- structured model instance and resource sharing observation (`model.instance: { instanceId, templateAssetId }`, `model.resourceSharing: { sharedGeometry: true, sharedTextures: true, uniqueSkeleton: true, uniqueMixer: true }`, `metrics: { assetTemplateParseCount, instanceCount }`);
- 6-scenario real Electron verification suite (`packages/verification/test/real-skinned-multi-instance.test.ts`) passing against dev Electron and packaged Windows executable (`KinetraGame.exe`).
- pure locomotion blend-space contract (`BlendSpace1DDefinition`, `BlendSpace2DDefinition`, schemaVersion: 1) with structured validation diagnostics (`anim.blendSpace.*`, each with a remediation hint) and deterministic weight evaluation: 1D linear between neighbours with end clamping, 2D cartesian gradient band interpolation, weights normalized to 1 and exact on samples, driven by `AnimationGraphMachine` number parameters (`evaluateBlendSpace`). Proof level: `@kinetra/animation` unit tests (`blend-space.test.ts`). Runtime playback (`ThreeSceneRuntime.playBlendSpace`/`setBlendSpaceInput`) with phase-synced clips of different lengths, atomic structured errors, takeover by direct playback, and reload restoration; proof: `packages/renderer-three/test/blend-space.test.ts` (11 tests) and real Electron `packages/verification/test/real-blend-space.test.ts` (1D weights/phase/errors/takeover + 2D pose equivalence with single-clip playback, PNG capture). Packaged-binary proof not yet run.
- morph targets (blend shapes): pure name catalog and all-or-nothing weight validation in `@kinetra/animation/morph-targets` (`anim.morph.*` diagnostics with remediation), engine-owned `MorphTargetController` per model instance in `@kinetra/renderer-three` (a target name shared by several meshes is driven as one value; overrides are re-applied after the mixer so they win over clip weight tracks; clearing restores authored defaults; overrides survive `reloadAsset` and targets the new asset lacks are reported as `animation.morphOverridesDropped`), observable as `model.morphTargets = { targets: [{ name, weight, meshes, overridden }], overrides }`, reachable from the bridge (`animation.setMorphWeights`, `animation.clearMorphWeights`) and game scripts (`animation.setMorphWeights`/`clearMorphWeights`). Proof level: `packages/animation/test/morph-targets.test.ts`, `packages/renderer-three/test/morph.test.ts`, real Electron `packages/verification/test/real-morph-targets.test.ts` (PNG capture). Not yet proven: the game-script path (wired, no test yet), packaged-binary run, Blender shape-key export, sparse-accessor/normal targets visual correctness, morph-target crossfade inside animation graphs.

- seeded property tests (`packages/animation/test/property.test.ts`, mulberry32 PRNG, 200 cases per property, failing seed/case reported) for the pure contracts: blend-space weights normalized/sorted/exact-on-sample, 1D position reconstruction and sample-order independence, 2D sample-order/translation/scale invariance; two-bone IK root fixed and exact bone lengths, reach within the annulus, straight extension out of reach, weight 0 keeps the end effector; FABRIK root fixed, bone lengths preserved, deterministic, convergence in the well-conditioned reach band (30–90% of chain length), never worse than the start; aim rotations are unit quaternions mapping before-bones onto after-bones (including 180°); morph catalog binds every slot once and requests are all-or-nothing. Known limitation found: FABRIK converges slowly for targets very close to the root (512 iterations can leave ~1e-3 m error).

- animation events, pure contract (`@kinetra/animation/events`, #90): text-defined `{clip, time, name, payload}` definitions are validated by `normalizeAnimationEvents`/`parseAnimationEventsText` with structured diagnostics (`animation.events.*`, each with remediation; malformed input never throws; payloads are deep-copied plain JSON, a JSON `__proto__` key stays data), and `ClipEventTracker` (`createClipEventTracker`) reports which events a playback head crossed: forward `(from, to]`, reverse `[to, from)`, start point included once, loop wraps and multi-loop steps fire once per crossing, non-looping clips clamp, fires capped per call (`truncated`). Fired events are identical for any partition of the same movement (seeded property test on exactly representable times). Proof level: `packages/animation/test/events.test.ts` (22 tests, pure Node). Renderer wiring (#90 part 2): `ThreeSceneRuntime.setAnimationEvents(raw)` validates and installs the event set; `updateAnimation` advances one tracker per clip action (active and outgoing) by the same clip time the mixer moved (action/mixer time scale, pause, restart, manual jump and loop wrap handled by re-syncing without firing the unseen range) and delivers events to `onAnimationEvent(listener)` after all entities moved (listener exceptions isolated and counted, listeners get payload copies), a bounded log (`getAnimationEventLog`, 256 entries, `getAnimationEventStats`) and runtime diagnostics (`getAnimationEventDiagnostics`). Proof level: `packages/renderer-three/test/animation-events.test.ts` (13 tests on a real GLB through the Node mixer; renderer-three 97/97). NOT yet wired: blend-space sample actions do not fire events (driven by normalized phase), ping-pong loops fire nothing (diagnostic), there is no `context.animation.onEvent` for scripts, no bridge/MCP command to set events or read the log, and no Electron-level test; floating-point accumulation means non-dyadic step partitions can differ by one ulp at an exact event boundary.

Still missing:
- animation events: blend-space actions, script `context.animation.onEvent`, bridge/MCP command and Electron proof (see above; #90 stays open until then);
- blend-space root motion (graph states that play a blend space, with crossfades into/out of it, are proven in unit tests and real Electron — see docs/architecture/ANIMATION.md; packaged-binary proof not yet run);
- inverse kinematics (IK) runtime adapter: `IkController` (renderer-three) applies the pure solver to named bones after `mixer.update()` via `ThreeSceneRuntime.setIkChains/setIkTarget/clearIkTarget`; it also runs for models without animation clips, restores the input pose of bones no clip rewrote (so partial weights do not compound and clearing a target un-bends the chain), applies chains in chain-id order; unit + runtime tests pass. The player bridge exposes `animation.ik.setChains`/`animation.ik.setTarget`/`animation.ik.clearTarget` (`packages/verification/test/real-ik-bridge.test.ts` covers structured error paths only, on a model without bones; it runs in CI since #118). Not yet proven: IK on a real skinned model through the bridge, authoring command-bus exposure, Electron acceptance, foot-planting helpers.

### Complete-game contracts

What exists:
- prefab template/override semantics;
- deterministic script lifecycle;
- scene lifecycle;
- action-based input + remapping;
- versioned save migration/store contracts;
- engine-owned file-backed desktop save storage (`FileKeyValueStorage`) with crash-resistant atomic replacement of completed temp files (fsync before rename) and bounded Windows retry;
- renderer IPC storage bridge (`IpcKeyValueStorage`) keeping filesystem paths outside renderer and project JSON;
- isolated test storage root (`KINETRA_SAVE_DIR` / `--save-dir=`);
- strict storage key validation and path traversal protection;
- multi-process save persistence (Process A saves -> terminates -> fresh Process B restores and continues gameplay);
- file-backed schema migration (v1 -> v2) and corrupt file/missing slot resilience;
- hierarchical audio buses (@kinetra/audio) with truthful gain/mute computation;
- deterministic synthetic WAV generation (`createSyntheticWav`);
- real Web Audio decoding and playback in Electron player runtime via Kinetra assetId;
- semantic audio command execution (`audio.play`, `audio.stop`, `audio.setBusGain`, `audio.setBusMuted`);
- truthful structured observation (`state.audio.initialized`, `state.audio.buses`, `state.audio.activePlaybacks`);
- structured error handling for missing/corrupt audio assets and unknown buses;
- clean audio resource teardown and session restart;
- real AcceptanceRunner verification and active-playback PNG frame capture.

Still missing:
- integrated runtime UI layer;
- end-to-end game loop proof in the real Electron player and the packaged binary (headless Orb Run keyboard/gamepad parity and save → restart → restore are covered by `examples/orb-run/test/input-parity.test.ts`, #92 partial).

### Verification

What has meaningful proof:
- pure acceptance-runner state machine (`AcceptanceRunner`);
- `FakeProbe` execution proof;
- real runtime probe adapter (`KinetraRuntimeProbe`) driving live Electron runtime host;
- semantic input injection (`input`), structured state query (`assert.equal`, `assert.near`), structured log verification (`assert.logAbsent`), and real frame capture (`assert.screenshotValidPng` with magic bytes and size check);
- machine-readable failure reports on deliberate assertion failures with exact failing step, expected/actual values, and `failureReason`;
- a missing `assert.equal` / `assert.near` path names the absent key and up to 12 sibling keys in `StepResult.diagnostics` (`kind: "missing_path"`). `expected` and `actual` stay the manifest comparison. Proof level: acceptance-runner unit test with `FakeProbe`. This is not Electron or packaged-executable proof;
- clean, leak-free process teardown and lifecycle management across repeated PASS/FAIL invocations;
- process smoke runner for packaged exes;
- MCP semantic tool `test.runAcceptance` exposing typed `AcceptanceManifest` execution over `@modelcontextprotocol/server`;
- engine-owned packaged executable resolution (`resolvePackagedExecutable`) targeting real `KinetraGame.exe` on Windows and `KinetraGame` on Linux, with `KINETRA_RUNTIME_EXECUTABLE` as an explicit override;
- truthful process observations proving executed target (`observations.hostInfo: { isPackaged, execPath, platform, arch }`);
- end-to-end acceptance suite running against both dev Electron and packaged Windows executable;
- full real-Electron verification suite (runtime, physics, navigation, GLB models, animation, gameplay scripts, save/load, audio, desktop save, arena, game shell, gameplay loop, combat, visual verification) is gated by `canRunRealElectronTests` (Windows always; Linux when `DISPLAY` is set; other platforms skip). Linux dev Electron and the packaged `KinetraGame` host share one switch list, `LINUX_ELECTRON_LAUNCH_ARGS` (`--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`, `--enable-unsafe-swiftshader`). `ElectronRuntimeHost` applies that list on Linux through `#platformLaunchArgs` for pipe and stdio, including the packaged executable. `realElectronLaunchArgs()` returns the same list and sets `KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW` so frame capture composites the WebGL canvas. The default host constructor leaves `electronArgs` empty, so Windows spawn arguments stay unchanged. Linux CI runs `pnpm --filter @kinetra/verification test` under xvfb (`.github/workflows/linux-verification.yml`). Local proof after merging packaged Linux into this branch: LINUX CLOUD, `pnpm check` and `xvfb-run -a pnpm --filter @kinetra/verification test` each reported `@kinetra/verification` 68 passed / 0 failed / 0 skipped. `smoke:linux` passed (2 iterations, no leaked processes). `package:linux` produced `KinetraGame-linux-x64/KinetraGame`, and `smoke:linux:packaged` passed with `isPackaged === true`, `platform === "linux"`, `arch === "x64"`. The verification suite is dev Electron. Packaged Linux proof is `smoke:linux:packaged`;
- command failures carry a stable `CommandError` code plus a remediation hint naming the next query or edit. MCP tool failures with a string `code`, and project validation failures with structured `issues`, are returned as JSON text. Schema failures that have no code stay plain text. Proof level: command-bus unit tests and in-memory MCP tool calls;
- bounded histories: `CommandBus` keeps at most `maxUndoDepth` (default 100) undo entries and `maxEventLogLength` event-log entries, an evicted undo token fails with `UNDO_EXPIRED`; `LocalRuntimeHost` keeps at most `MAX_LOCAL_RUNTIME_LOG_ENTRIES` (5000) log entries. Proof level: `packages/command-bus/test/bounded-history.test.ts`, `packages/mcp-server/test/local-runtime-logs.test.ts` (Node unit tests);
- built-in component payloads are checked at the authoring boundary (#81): `validateBuiltInComponent` / `assertValidProject` in `@kinetra/project-model` validate the known fields of `Transform` (position/rotation/scale: exactly three finite numbers), `Primitive` (`kind` box/sphere/plane, colour, roughness/metalness in 0..1, size/radius/width/height/segments bounds), `Camera` (`type`, `fov` in (0,180), `aspect`, `near`, `far > near`), `Light` (`kind`, colour, `intensity >= 0`), `Model.assetId` and `Script.scriptId/order`. A bad `entity.create` / `entity.patch` now fails with structured `issues` (`path`, `code` like `component.Primitive.kind.invalid`, `message`, `remediation`) and leaves the revision unchanged. Unknown fields and other components (`Collider`, `RigidBody`, custom ones) stay free-form. Proof level: project-model, command-bus and in-memory MCP tests. Not done: schemas for `Collider`/`RigidBody`/`CharacterBody`/`NavMesh`, a `component.remove` command (the other half of #81), and the renderer still keeps its lenient fallbacks for projects that bypass the bus;
- **Engine-Owned Perceptual Visual Analysis (`@kinetra/verification`)**: Pure TypeScript image analysis (zero native binaries, pure JS `pngjs`) computing deterministic `VisualFrameEvidence` (`sha256`, `width`, `height`, `meanLuminance`, `luminanceVariance`, `entropy`, 64-bit dHash `perceptualHash`, Sobel `edgeDensity`, `opaquePixelRatio`);
- **Blank Frame Detection (`detectBlankFrame`)**: Detects solid color, completely dark/transparent, and low-entropy blank frames with machine-readable reasons;
- **Perceptual Frame Comparison (`compareVisualFrames`)**: Calculates Hamming distance on dHash, changed pixel ratio against configurable luminance/RGB deltas, and mean absolute difference;
- **Additive Acceptance Manifest Steps**: Backward-compatible extension of `AcceptanceStep` schema: `capture.frame` (retains named image buffers in `capturedFrames` per run, optional artifact save), `assert.visualNotBlank`, `assert.visualSimilarity`, `assert.visualDifference`, and `critique.visual`;
- **Direct Canvas Frame Capture**: Player runtime enables `preserveDrawingBuffer: true` and supports direct WebGL canvas capture via `toDataURL("image/png")`, ensuring 100% deterministic, immediate frame retrieval on headless or hidden windows without OS compositor lag or stale frame cache;
- **Controlled Visual Regression Catch**: Defective scene passes entity loading, runtime running, log absent, and valid-PNG checks, but perceptual similarity `assert.visualSimilarity` catches the visual regression with machine-readable `expected` and `actual` diagnostics (`visual.perceptualMismatch`), while `assert.visualDifference` passes and repaired scene passes;
- **Real Arena Visual Verification**: Proves non-blank baseline, same-state stability/similarity, and active player movement across the camera registering perceptual difference (`arenaStart` vs `arenaMoved`);
- **Provider-Neutral Vision Critique Hook**: `VisualCritiqueProvider` interface with structured `VisualCritiqueReport` (`score`, `critique`, `defects`, `passed`), deterministic `FakeVisualCritiqueProvider`, and provider error isolation preventing critique failures from crashing the runtime host;
- **Windows Packaged Smoke Suite**: Packaged executable smoke test (`smoke:win` on `KinetraGame.exe`) runs real visual verification against the packaged player;
- **Runtime Performance Telemetry & Acceptance Budget Gate (`@kinetra/verification`)**:
  - **Capture Mode Boundary**: Explicit separation of performant normal shipping configuration (`preserveDrawingBuffer: false`, `captureMode: "performance"`) from visual verification capture (`preserveDrawingBuffer: true`, `captureMode: "visual"`), exposed truthfully in `hostInfo` and `query.renderer`;
  - **Structured Evidence Model (`RuntimePerformanceEvidence`)**: Sample count, warmup exclusion, execution mode (`stepped` vs `continuous`), deterministic linear rank percentiles (`p50Ms`, `p95Ms`, `p99Ms`, `maxMs`) for frame, simulation, and render CPU timings;
  - **Authoritative Engine & Three.js Counters**: Real Three.js renderer metrics (`renderer.info.render.calls`, `triangles`, `points`, `lines`, `geometries`, `textures`), scene metrics (`objectCount`, `visibleObjectCount`, `modelInstanceCount`, `skinnedMeshCount`, `activeAnimationMixerCount`), and physics stats (`bodyCount`, `colliderCount`);
  - **Additive Manifest Steps**: Semantic `performance.sample` and `assert.performanceBudget` steps supporting grouped multi-metric thresholds, platform overrides (`windows`, `linux`), and machine-readable `performance.budgetExceeded` failure diagnostics;
  - **Mandatory Deliberate Regression Proof**: A 35-primitive scene structurally exceeds `renderer.drawCalls <= 15`, failing deterministically with exact violated metric, limit, and actual count, while fixed 2-primitive composition passes;
  - **Resource Lifecycle & Multi-Instance Proofs**: Repeated stop/start scene transitions show zero monotonic geometry/texture growth, and multi-instance workloads retain single template parse deduplication (`assetTemplateParseCount == 1`);
  - **Compact Artifact Emission**: `writePerformanceReport` generates structured, machine-readable `performance-report.json` artifacts;
  - **Packaged Binaries Verification**: Real `KinetraGame.exe` (Windows) and `KinetraGame` (Linux) verified passing performance budgets via smoke scripts.

What remains:
- authenticated live multimodal AI critique (e.g. Gemini 2.5 / Claude 3.7 vision model calling live API);
- complete-game shipping acceptance suite;
- committing real Electron-rendered baselines and gating them in CI (the baseline store, check/update logic and CLI exist and are unit-tested — `packages/verification/src/visual-baseline.ts`, `pnpm --filter @kinetra/verification visual-baseline check|update <baselines.json> <frames-dir>` — but no baseline file is committed yet and no CI job feeds real frames into it; `update` needs `--confirm` and refuses when `CI`/`GITHUB_ACTIONS` is set).

### Runtime bridge (P2)

What has meaningful proof:
- Electron player runtime controlled over Windows named pipes (`ElectronRuntimeHost`);
- cross-platform stdio bridge transport (`transport: "stdio"`) with identical request/response protocol, proven by Linux cloud smoke;
- one-command Linux runtime smoke (`pnpm --filter @kinetra/player smoke:linux`): real Electron under xvfb, stdio bridge, Kinetra Arena start/query/step/semantic-input/valid-PNG-capture/stop, repeated runs with zero-leak `/proc` proof, frames + `report.json` artifacts, Linux CI workflow;
- handshake synchronization (document load + renderer ready via `.cts` preload script);
- project scene instantiation with primitives (box, sphere, plane), lights, and cameras;
- live structured entity query and semantic input injection (`runtime.injectInput`);
- structured runtime log recording;
- real non-empty PNG frame capture via `webContents.capturePage()`;
- clean teardown without leaked Electron processes or dangling pipe sockets;
- packaged Windows executable (`KinetraGame.exe`) smoke test and runtime bridge compatibility.

What remains:
- none for core P2 runtime bridge scope (real GLB asset loading is proven).

### Physics (P7 Slice 1)

What has meaningful proof:
- minimal, deterministic Rapier 3D integration via `@dimforge/rapier3d-compat` in `@kinetra/physics-rapier`;
- fixed-step accumulator and simulation independent of render delta partition;
- dynamic body gravity fall and static floor collision without tunneling;
- kinematic character controller driven by semantic input (`player.moveRight`) with obstacle collision clipping (`actual displacement < requested displacement`);
- a kinematic `RigidBody` (`kinematic`/`kinematicPositionBased`/`kinematicVelocityBased`) with an explicit box or sphere `Collider` and no `CharacterBody` keeps that shape (`addKinematicBody`, driven by `moveKinematicBody` via `setNextKinematicTranslation`, so dynamic bodies on it are carried); capsule or undeclared shapes stay character bodies. Known limit: `kinematicVelocityBased` is driven by target position, not by an authored velocity (#311);
- real-time transform synchronization from physics world into Three.js scene graph;
- deterministic stepping command (`runtime.step`) exposed over the runtime bridge;
- full acceptance verification (`real-physics.test.ts`) driving live Electron runtime with real PNG capture and clean teardown;
- engine-level spatial queries on `RapierPhysicsWorld`: `raycast` and `shapeCast` (sphere / box / capsule, optional rotation) return Kinetra-owned `PhysicsHit` structs (`entityId`, `point`, `normal`, `distance`, `startedInside`) with no Rapier handles, filter by query layer (`Collider.layer`, 0..31, default 0) and `excludeEntityIds`, never advance the simulation (stale broad phase refreshed with a zero-timestep step; a test proves an interleaved-query run is bit-identical to a query-free run), and reject malformed input with `RangeError`. Proven by 16 unit tests in `packages/physics-rapier/test/queries.test.ts`. Sphere-cast contact points are exact (closest point on the hit collider at impact); box/capsule contact points come from Rapier's iterative time-of-impact solver and are only accurate to ~1e-2; `distance` is accurate to ~1e-4. `startedInside` also covers a ray that starts exactly on a surface, whatever its direction.
- body creation validates its input before touching Rapier: non-finite positions, non-positive extents/radii/half-heights/mass, negative or non-finite friction/restitution/offset/autostep values throw `RangeError`, and an unsupported dynamic shape or a rejected collider can no longer leave an orphan rigid body in the world; `createPhysicsWorldFromScene` disposes the WASM world when an entity is rejected (`packages/physics-rapier/test/validation.test.ts`, 15 tests; 44 physics tests total).

Still missing:
- exposing `raycast` / `shapeCast` to game scripts (`context.physics`) and the runtime bridge, plus a real-Electron test (the query API is currently proven at the `@kinetra/physics-rapier` level only);
- collision layers that change *simulation* collisions (`Collider.layer` is a query filter only, #94);
- physics materials / dynamic friction/restitution overrides;
- compound colliders and trimeshes.

### Navigation (P7 Slice 2 & 2B)

What has meaningful proof:
- isolated, deterministic Recast Navigation integration via `@recast-navigation/core` and `@recast-navigation/generators` in `@kinetra/navigation-recast`;
- async initialization with clean disposal (`nav.dispose()`);
- Solo NavMesh baking from synthetic vertices and triangle indices;
- closest point query with configurable half-extents (resolving the historical vertical search extent failure on elevated coordinates);
- waypoint path calculation between start/end points with complete status reporting;
- deterministic binary NavMesh serialization (`toBytes`) and deserialization (`fromBytes`) round-trip;
- full real Electron player runtime integration (`PlayerRuntimeController` navigation adapter, named pipe bridge, and renderer IPC);
- structured, Kinetra-owned runtime navigation state queryable without exposing raw Recast/Detour handles;
- complete AcceptanceRunner verification in live Electron (`real-navigation.test.ts`), covering baking, elevated closest-point, pathfinding, serialization reload equivalence, deliberate out-of-bounds/constrained failure, real PNG capture, and clean teardown leaving zero orphan processes.

Still missing:
- crowd agent steering / crowd simulation;
- dynamic obstacle avoidance / tile cache.

### Reference game (P10 Slice 1, Slice 2, Slice 3, Slice 4 & Slice 5)

What has meaningful proof:
- complete reference game vertical slice authored as standard Kinetra project data (`@kinetra/reference-game`);
- Arena authoring snapshot `examples/reference-game/arena.kinetra.json` matches `createArenaProject()` after schema validation and canonical serialization, including the Player, Enemy, SecurityConsole, PowerCore, Goal, ArenaManager, and MainCamera ids. A temp copy (the checked-in file is not written) can be inspected, queried for Player, patched on PowerCore through the command bus, observed in real Electron (`Player` x stays `-5`, `PowerCore` x becomes `4`, valid PNG), and undone back to the original bytes. Proof: `arena-file-workflow` passed under `DISPLAY` (REAL ELECTRON, dev host). Runtime boot still uses `createArenaProject()`, not this file;
- real Electron runtime boots directly into main menu shell with standard DOM/CSS overlay (`apps/player`);
- player controllable via 3D semantic input (`player.moveRight`, `player.moveLeft`, `player.moveForward`, `player.moveBackward`, `player.attack`) and Gamepad snapshot provider;
- script-owned gameplay transforms synchronized with scene graph and Rapier physics;
- arena environment with perimeter walls, central obstacle, security console, power core, exit goal, and real Recast NavMesh;
- hostile enemy using Recast pathfinding to navigate around obstacle, chase player, and inflict damage within 1.6m range with cooldown;
- repeatable gameplay loop: Main Menu -> Start Run -> Explore Arena -> Complete Objectives -> Lockdown Challenge -> Escape Goal -> Victory / Defeat;
- explicit run status (`run.status: "idle" | "active" | "completed" | "failed"`);
- 3 deterministic objectives tracked as structured runtime state: `obj_activate_terminal` (Security Console), `obj_retrieve_core` (Power Core), `obj_survive_escape` (Exit Goal);
- HUD projection: displays player HP, current active objective description, and completed count `(completed/total)`;
- Lockdown Survival Challenge: triggered upon Power Core retrieval, boosting enemy speed by 1.6x (`0.8 -> 1.28`), logged via `gameplay.challengeStarted` event, with explicit challenge status (`idle`, `active`, `completed`, `failed`);
- deterministic combat foundation: semantic input `player.attack` (mapped to `KeyF`, `KeyJ`, gamepad button 2) with simulation cooldown (2 steps), range check (2.0m), and structured events (`player.attackHit`, `player.attackMiss`);
- bidirectional authoritative damage model: Player deals damage to Enemy via `gameplay.enemyDamage` (reducing enemy HP), Enemy deals damage to Player via `gameplay.damage` (reducing player HP), with both health values bounded in `[0, 3]`;
- enemy defeat state: when Enemy health reaches 0, transitions to `state: "defeated"`, emits `enemy.defeated` and `gameplay.enemyDefeated`, and halts navigation, chase pathfinding, and attack execution;
- combat feedback layer: hurt state reactions (`player.hurt`, `enemy.hurt` events), `hurtCooldown` (1 step) preventing multi-hit stuns, and hit sound (`ARENA_SFX_HIT_ASSET_ID`) on the `sfx` bus;
- enemy attack telegraph state machine: explicit deterministic transitions (`chasing` -> `telegraph` -> `attacking` -> `cooldown` -> `chasing`) providing a 1-step reaction window where the player can evade or trade attacks;
- encounter completion & extraction progression: defeating enemy unlocks extraction (`encounter.extractionUnlocked = true`), required to complete `obj_survive_escape` and achieve run victory;
- authoritative run summary statistics: tracks `elapsedSteps`, `elapsedTimeMs`, `damageDealt`, `damageTaken`, and `enemiesDefeated` during active runs;
- Pause & Settings: `game.pause` freezes simulation, physics, and input; persistent audio and keybinding settings across process restarts;
- deterministic WIN state (`run.status == "completed"`, `status == "won"`) and LOSE state (`run.status == "failed"`, `status == "lost"`);
- real deterministic synthetic audio playback via assetId (`asset_arena_sfx_hit`, `asset_arena_sfx_win`, `asset_arena_sfx_lose`);
- multi-process save & restore persistence across process boundaries: Process A saves intermediate run progress -> terminates -> Process B restores exact player position, player health, enemy health, enemy state, attack cooldown, telegraph timer, hurt cooldown, objective progress, challenge state, extraction unlocked state, and run statistics, finishing the run;
- automated `AcceptanceManifest` execution against both dev Electron runtime and packaged Windows executable (`KinetraGame.exe`) via MCP `test.runAcceptance`;
- real valid PNG capture for Main Menu, HUD, Objective 1, Objective 2, Victory, Defeat, Combat, and Progression states;
- deliberate failure producing structured machine-readable step evidence and clean zero-leak teardown.

Not yet implemented:
- multiple levels / procedural rooms;
- weapons / inventory;
- multiple enemy types;
- complex enemy behavior trees or AI perception models.

### Dogfood sample: Orb Run (`examples/orb-run`)

Convention: each sample game is its own workspace package under `examples/<name>/` (picked up by `pnpm-workspace.yaml`) with its own `build`/`typecheck`/`test` scripts.

What has meaningful proof (Slice 1, Node only):
- the whole project is authored from an empty project through the real MCP server (`scene.create`, `entity.create`, `entity.patch` over the in-memory transport, one revision per call with `expectedProjectRevision`); the file `FileProjectStore` writes equals the checked-in `orb-run.kinetra.json`, and replaying the same plan through `CommandBus` gives the same bytes;
- gameplay scripts on the `@kinetra/core` `GameScript` contract run in a headless `ScriptHost` harness (`HeadlessSceneSimulation`, example-local) at a fixed 1/30 s step: a semantic-input playtest bot wins; exit-before-orbs, timeout loss, arena clamp, determinism, mid-run save/restore into a fresh simulation, corrupt-save rejection, and a rules change made through the command bus are asserted;
- Slice 2: the gameplay contracts are checked-in `AcceptanceManifest` JSON (`examples/orb-run/acceptance/`: win, timeout, save-load) executed by the engine's own `AcceptanceRunner` through an example-local headless `RuntimeProbe` (`OrbRunHeadlessProbe`, virtual fixed-step time); negative cases (missing path diagnostic, screenshot step without a renderer, corrupt save, rules rebalanced through the command bus, typo'd script id) fail at the expected step;
- Slices 3-5: pure animation contracts (speed-driven locomotion blend space, two-bone foot placement with `solveTwoBoneIk`) and audio cues through an example-local `HeadlessAudioService` (exact cue order, bus gains, mute, restore, refusing service), all asserted without a renderer;
- Slice 6: a HUD contract (`computeOrbRunHud`: objective, orb counter, `m:ss` timer with warning/critical/expired urgency, nearest-target compass marker, win/loss banner) as a pure function of gameplay state; exposed to acceptance as `state.hud.*` and asserted by `hud` and `hud-timeout` manifests, identical after a save/restore;
- Slice 7: Orb Run's content goes through the asset pipeline: three deterministic GLB models and six WAV cues registered as `AssetRecord`s (synthetic provenance) and imported by the engine's `AssetReimportService` on an in-memory file system with example-local GLB/WAV importers; asserted: clean validation, byte-identical rebuilds, no-op re-import, an edit reimports only that asset, a corrupt source keeps the last good artifact, provenance policing;
- Slice 8: the animation contracts now run off real gameplay: `OrbRunAnimator` observes the headless simulation after every fixed step (new read-only `onStep` hook) and turns player speed into locomotion blend weights and planted feet on a pluggable ground function; asserted: planted feet with exact bone lengths on a full winning run, `idle → walk → run → walk → idle`, step-up/drop-off/unreachable ledge, deterministic traces, restore restarts from rest, a failing ground function never affects the outcome; exposed as `state.animation.*` and the `animation` manifest;
- Slice 9: the content is part of the acceptance gate: `OrbRunAssetCatalog` imports every asset once and hot-reimports an edited source; the headless probe exposes `state.assets.*` and the `asset.register` step, and `acceptance/assets.acceptance.json` asserts exact metadata, an artist edit (revision 2, new fingerprint, game state untouched), a corrupt source that keeps the last good artifact, healing, and that every played cue is backed by a registered asset;
- Slice 10: replays as a gameplay regression gate: a run is recorded as its fixed step, the changes of the held semantic actions and a SHA-256 state digest every 30 steps (`OrbRunReplayRecorder`, `playOrbRunReplay`, strict `parseOrbRunReplay`); the committed `acceptance/replays/{win,timeout}.replay.json` replay `verified` and equal a fresh recording, a dropped or shifted input or a rebalance through the command bus is caught at the first diverging checkpoint, and the headless probe exposes the same digest as `state.replay.{step,digest}` so a manifest can pin a whole run.
- Slice 11: replays as manifests: `createOrbRunReplayManifest` turns a recording into an `AcceptanceManifest` (`acceptance/replay-{win,timeout}.acceptance.json`) that pins `state.replay.digest` at every checkpoint on the engine `AcceptanceRunner`; the state digest now covers every entity position (not only scripted ones); `playOrbRunReplay` yields to the event loop every 2048 steps and accepts `maxSteps` and an `AbortSignal`;
- Entry hygiene (#309): `digestOrbRunState` uses a pure-JS SHA-256 (`src/sha256.ts`, byte-identical to `node:crypto`, pinned by reference vectors and a 0–200 byte sweep) so the package entry has no `node:*` import (a test scans `dist/src`; only `write-snapshot.ts`, not exported, uses `node:fs`). The digest is cached per `HeadlessSceneSimulation.stateRevision` (bumped by every step and restore), so repeated `state` probe reads do not re-hash the event log. Not proven: a real Vite/browser bundle of Orb Run (no player loads it yet, #185/#212).
- proof: `pnpm --filter @kinetra/example-orb-run test` (148 tests).

Not yet proven: rendering (the HUD is a model, nothing draws it; the imported assets are never loaded by a renderer), the Electron player, packaged builds. The player cannot load a sample's scripts yet (it hard-codes the Arena registrations), and there is no engine-owned headless world; see `examples/orb-run/README.md`.

## Open implementation references

### PR #29 — P2 Electron runtime bridge

Superseded by `feat/p2-real-runtime-bridge`. Proven on Windows with deterministic tests, real PNG capture, and clean teardown. Safe to close after branch review.

### PR #26 — P7 Rapier/Recast

Old exploratory branch with failing tests around character-controller queries and Recast extents.
Superseded by `feat/p7-rapier-physics-slice` (Rapier physics) and `feat/p7-recast-navigation-slice` (Recast navigation), both of which are now proven in the real Electron player runtime.

### PR #28 — P9 distribution contracts

Safe to study for:
- release manifest;
- artifact layout;
- signing-plan abstraction;
- optional Steam bridge;
- SteamPipe VDF generation.

Credentials are intentionally not part of repository code.

### PR #22 — old P3 editor

Use only as UX/architecture reference:
- hierarchy;
- viewport;
- TransformControls;
- inspector;
- Monaco;
- Play/Stop;
- command history.

Its base is obsolete. Recreate it on a fresh branch after P2.

## Branch hygiene rule

For the next implementation cycle:

- branch from current `main`;
- one phase/vertical slice per PR;
- no deep stacked PR chain;
- do not leave failing experimental PRs looking merge-ready;
- convert experiments to draft or close them with a handoff note.
