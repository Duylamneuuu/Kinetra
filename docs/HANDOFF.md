# Kinetra handoff — 2026-09-19 (updated 2026-10-09 through PR #75)

This document exists so the next coding agent can continue without reconstructing the entire development history.

## Product intent

Kinetra is an **AI-first 3D game engine built around TypeScript + Three.js**.

Three.js is the renderer/library, not the language. TypeScript is the primary implementation language.

The engine is intended to produce **complete Windows games**, not browser-only demos. The visual editor is secondary. The AI-facing structured command/query/runtime interface is primary.

## Architecture thesis

```text
AI agent / supervisor
        |
        v
MCP / typed agent tools
        |
        v
Command + Query Bus
        |
        +-------------------------+
        |                         |
        v                         v
Text Project Model          Human observer editor
        |
        v
Runtime systems
  Three.js
  physics
  navigation
  animation
  input/audio/save
  assets
        |
        v
Verification
        |
        v
Windows packaged executable
```

The source of truth is text/schema data. Three.js scene objects are runtime projections only.

## What is safely on main

The repository has already established the architectural foundation and several tested subsystem cores.

See `docs/STATUS.md` for the exact phase matrix.

At a high level, `main` contains:

- versioned project model + migrations;
- typed command/query bus;
- minimal Three.js runtime projection;
- dependency/license guardrails;
- standalone Windows Electron packaging spike;
- MCP/service baseline;
- deterministic Blender/GLB asset-core work;
- animation semantic core;
- complete-game contracts for script lifecycle, prefabs, input, audio, save/settings;
- verification/acceptance core.

These are foundations, not proof that the whole engine is finished.

## Important WIP branches / PRs

Treat the following only as implementation references until re-proven. Since this list was written, the real Electron runtime bridge (#31), Rapier physics (#33) and Recast navigation (#34) landed on `main` through separate PRs, so #29 and #26 are now historical references rather than the path to those features. #22 is closed.

- **PR #29** — Electron runtime bridge / real frame capture.
  - useful design/reference;
  - not part of `main`;
  - requires fresh bounded Windows integration validation before merge.

- **PR #26** — Rapier + Recast integration.
  - library adapters exist;
  - CI exposed real behavior mismatches in character-controller/navmesh tests;
  - do not merge without repairing behavior, not merely weakening assertions.

- **PR #28** — release/Steam distribution contracts.
  - useful release-layout/signing/SteamPipe contract ideas;
  - real signing and Steam upload require external credentials;
  - not required for normal engine runtime.

- **PR #22** — observer editor.
  - old stacked branch based on an earlier P2 branch;
  - use as a reference for editor shape only;
  - do not merge as-is.

## Why development paused here

A long coding run created too much parallel WIP. Continuing to add more systems before consolidating would increase hidden integration errors.

The next agent should **not** continue by implementing every roadmap phase in one run.

Instead:

1. pick one phase;
2. define one acceptance gate;
3. use a fresh branch from current `main`;
4. port only the necessary ideas from WIP PRs;
5. run CI;
6. merge only when the behavioral gate passes.

## Recommended continuation order

### 1. Finish P2 — real runtime bridge

Goal: prove an agent can run the real project, query it, inject semantic input, capture a real frame and read logs.

Do this before the editor.

### 2. Rebuild/port P3 observer editor on top of accepted P2

The editor must call the same command bus as AI tools. It must not become a second hidden authoring path.

### 3. Finish P7 physics/navigation as a small vertical slice

Prove:
- one dynamic rigid body;
- one authoritative character movement path;
- one baked navmesh;
- one path query;
- deterministic cleanup.

Do not start crowds/LOD/perf extras first.

### 4. Wire P8 acceptance runner into the runtime/MCP

P8 MCP acceptance execution (`test.runAcceptance`) and packaged-runtime verification are proven against dev Electron and `KinetraGame.exe`.

### 5. Reference game (P10 Slice 1, Slice 2, Slice 3, Slice 4 & Slice 5 Proven)

The bounded reference-game vertical slice ("Kinetra Arena") is proven on top of P2, P6, P7, and P8 against both dev Electron and packaged `KinetraGame.exe`. It verifies the autonomous loop: author -> run -> observe -> test -> fix -> package -> verify packaged build.
Slice 1 proved core movement, NavMesh chase, win/lose, audio, and save/load.
Slice 2 proved the player-facing shell: Main Menu, HUD, Pause, Settings, Gamepad snapshot provider, and Result screens.
Slice 3 proved the repeatable gameplay loop: explicit run status (`idle` -> `active` -> `completed`/`failed`), 3 structured deterministic objectives (Security Console, Power Core, Escape Goal), HUD projection with completed count, Lockdown Survival Challenge with 1.6x enemy speed boost, and multi-process save/restore preserving exact progress.
Slice 4 proved the combat foundation: deterministic player combat action (`player.attack`), cooldown and 2.0m range check, structured hit/miss events, bidirectional damage model (player damages enemy, enemy damages player, health bounded in [0, 3]), enemy defeated state halting navigation and attacks, combat audio feedback, multi-process save/restore of combat state, and full 5-scenario acceptance against packaged `KinetraGame.exe`.
Slice 5 proved combat feel and encounter progression: enemy attack telegraph state machine (`chasing` -> `telegraph` -> `attacking` -> `cooldown` -> `chasing`) with deterministic reaction window, hurt reactions and cooldowns (`player.hurt`, `enemy.hurt`), encounter completion and extraction unlock progression (`encounter.extractionUnlocked = true`), authoritative run summary statistics (`elapsedSteps`, `elapsedTimeMs`, `damageDealt`, `damageTaken`, `enemiesDefeated`), multi-process save/restore across process restarts, and full 7-scenario acceptance against packaged `KinetraGame.exe`.
 
### 6. AI Asset Production (Scenario Orchestration Boundary & Ingestion Proven)

The external AI asset generation pipeline orchestration boundary and ingestion contracts are proven:
- Scenario MCP boundary isolated from runtime player;
- Kinetra-owned orchestration skill (`.agents/skills/kinetra-scenario-asset/SKILL.md`);
- Ingestion pipeline with validation, normalization, sha256 content hashing, stable `assetId`, and provider-neutral `AssetProvenance` metadata;
- Deterministic local prop fixture (`examples/reference-game/assets/props/energy-crate.glb` generated via `createSyntheticPropGlb` with `energy-crate.asset.json`);
- 5-scenario acceptance suite (`packages/verification/test/real-scenario-asset.test.ts`) verifying ingestion, command bus mutation, real Electron WebGL projection, structured model queries, deliberate missing-asset failure resilience, and clean teardown;
- Not yet proven: a real authenticated Scenario `model_run` → download → Kinetra import execution (requires external credentials/live run).

### 7. Rigged Character Combat Animation (P10 Slice 6 Proven)

The rigged 3D character combat animation vertical slice is proven against dev Electron and packaged `KinetraGame.exe`:
- Programmatic synthetic rigged character generation (`createSyntheticCharacterGlb`) with `SkinnedMesh`, 7-bone hierarchy (`Hips`, `Spine`, `Head`, `LeftArm`, `RightArm`, `LeftLeg`, `RightLeg`), and 6 combat clips (`idle`, `walk`, `telegraph`, `attack`, `hurt`, `defeat`);
- Canonical rigged character asset fixture (`examples/reference-game/assets/characters/enemy-bot.glb` & `enemy-bot.asset.json`) with truthful Kinetra synthetic fixture provenance;
- Three.js SkinnedMesh and Skeleton projection in the Electron player runtime, populating structured query fields (`entity.model.skinnedMeshCount`, `entity.model.hasSkin`);
- Engine-owned semantic animation layer exposing `context.animation.play(clipName, options)`, `stop()`, `activeClip`, and `playing` to scripts without exposing `THREE.AnimationMixer`;
- Truthful structured gameplay state observation via `entity.gameplay.animation: { activeClip, playing, speed }`;
- Authoritative gameplay/physics ownership: animation drives visual mesh poses in place, while Rapier physics owns character position and combat timings operate independently;
- Deterministic synchronization between `ArenaEnemyController` combat state machine (`chasing` -> `telegraph` -> `attack` -> `hurt` -> `defeat`) and character animation clips;
- 10-scenario real Electron verification suite (`real-character-animation.test.ts`) passing against dev Electron and packaged Windows binary (`KinetraGame.exe`);
- Full regression suite passing all 7 packaged test suites: Acceptance MCP, Arena, Game Shell, Gameplay Loop, Combat, Combat Progression, and Character Animation.

### 8. Real External Humanoid Retargeting & Persistent Bake Cache (P5 Proven)

The humanoid animation retarget baking and persistent bake cache vertical slices are proven against dev Electron and packaged `KinetraGame.exe`:
- Truthful external asset provenance: ingested real external humanoid/skinned GLB `CesiumMan.glb` (CC-BY 4.0, Khronos Group / Cesium) with truthful provenance in `cesium-man.asset.json` and license policy tracking (`allowedWithNotice`);
- Skeleton hierarchy inspection (`inspectSkeletonFromGlb` via `@gltf-transform/core`) discovering external artist bones (`Skeleton_torso_joint_1`, `leg_joint_L_1`, etc.) and target character bones (`Hips`, `Spine`, `Head`, `LeftArm`, `RightArm`, `LeftLeg`, `RightLeg`);
- Semantic humanoid bone mapping (`sourceBone -> semanticBone -> targetBone`) bridging distinct artist naming conventions;
- Real transform retarget baking (`bakeRetargetedClip`) generating target-specific `THREE.AnimationClip` referencing target skeleton bone names with normalized delta quaternions relative to rest poses;
- Explicit hips translation policy (`"ignore"` by default for clean separation from Rapier physics);
- Deterministic retarget cache key (`computeRetargetCacheKey`) sensitive to sourceAssetHash, sourceClipId, source/target skeleton signatures, semantic mapping, settings, and retargetVersion;
- Engine-owned persistent baked-retarget cache (`RetargetBakeCache`, `FileRetargetCacheStorage`) wrapping Three.js `AnimationClip` in versioned record (`RetargetCacheRecord`);
- Multi-process cache reuse across independent Electron processes (Process A MISS/bake/persist -> Fresh Process B HIT/load/playback) without recomputing retarget transforms;
- Deterministic cache invalidation on changed source asset hash, semantic mapping, target skeleton, or retarget settings/version;
- Resilient recovery from corrupted cache artifacts and stale schema versions reporting structured `regenerationReason`;
- Structured cache observation (`cacheKey`, `cacheHit`, `cachePath`/`cacheIdentity`, `bakedClipName`, `trackCount`, `regenerationReason`) without exposing arbitrary local filesystem paths to project data;
- Structured diagnostics for missing or incompatible bones with actionable remediation hints (`retarget.bone.missing-required`, `retarget.clip.no-usable-tracks`);
- Dynamic runtime clip registration (`ThreeSceneRuntime.registerAnimationClip`) and IPC handler (`animation.registerClip`) enabling runtime clip injection into `THREE.AnimationMixer`;
- Electron runtime playback of baked retargeted clip on target SkinnedMesh (`EnemyBot`);
- Deterministic simulation stepping advancing retargeted clip mixer time and updating target bone rotations;
- Runtime state observation exposing `retargetSource` and `retargetCacheKey`;
- Real WebGL frame capture producing valid PNG during retargeted animation playback;
- Scene reload/restart clearing stale mixer state and allowing clean re-playback without leaks;
- Complete 12-scenario real Electron verification suite (`real-humanoid-retarget.test.ts`) passing against dev Electron and packaged Windows binary (`KinetraGame.exe`).

### 9. Runtime Animation Graph & Deterministic Crossfade (P5 Proven)

The text-backed animation graph runtime and deterministic crossfading slice is proven in dev Electron and packaged `KinetraGame.exe`:
- Text-backed schema-versioned animation graph format (`AnimationGraphDefinition`, `AnimationGraphMachine`, schemaVersion: 1) supporting typed parameters (`bool`, `number`, `trigger`), conditions (`==`, `!=`, `<`, `<=`, `>`, `>=`, `triggered`), priorities, wildcard source transitions (`from: "*"`), and transition `blendSeconds`;
- Engine-owned runtime animator session (`EntityAnimatorSession`, `AnimatorBlendSession`) on `ThreeSceneRuntime` managing concurrent `activeAction` and `outgoingAction` weights;
- Deterministic weight shifting in `ThreeSceneRuntime.updateAnimation(deltaSeconds)` advancing weight smoothly across discrete simulation steps (`runtime.step(fixedDeltaSeconds)`) for `blendSeconds > 0`, and zero-latency immediate switching for `blendSeconds == 0`;
- Mid-blend interruption policy stopping superseded outgoing actions immediately with zero weight and demoting active action to outgoing without action leakage;
- Observable structured graph state (`model.animation.graph = { state, previousState, transitionId, transitioning, blendSeconds, blendElapsed, blendProgress }`) and concurrent weighted actions (`model.animation.actions = [{ clip, weight, role }]`);
- Transparent resolution of retargeted clips (`${name}_retargeted`) in graph states and crossfades;
- Negative proofs emitting structured diagnostics and errors for invalid graph schemas, unknown clips, unknown parameters, type mismatches, and unknown triggers without crashing the runtime;
- Reference game integration where `ARENA_ENEMY_ANIMATION_GRAPH` drives EnemyBot combat lifecycle (idle, walk, telegraph, attack, hurt, defeat) without altering damage timing, reaction windows, or combat logic;
- Comprehensive real Electron verification suite (`packages/verification/test/real-animation-graph.test.ts`) passing all 8 scenarios with valid PNG capture during active blend;
- 100% pass across full workspace check (`pnpm check`) and packaged Windows binary (`smoke:win` on `KinetraGame.exe`).

### 10. Deterministic Root Motion → Rapier Character Motion (P5 Proven)

The root motion extraction and Rapier character motor integration slice is proven in dev Electron and packaged `KinetraGame.exe`:
- **Truthful Source Inspection**: `inspectClipRootMotion` inspects animation clips and truthfully identifies that CesiumMan's animation is an in-place walk (4mm net displacement over 2.0s, max XZ excursion < 0.07m), while the synthetic RootMotionBot is a genuine locomotion clip (~1.6m forward travel per 1.0s loop);
- **Deterministic Delta Extraction**: `extractRootMotionFromClip` and `computeRootMotionStepDelta` sample continuous root displacement per simulation step, achieving partition invariance and smooth loop wrapping across boundary discontinuities without position spikes;
- **No Double Motion**: `stripVisualRootDisplacement` zeroes local X and Z positions on the visual skeleton Hips node while preserving vertical (Y) pelvic bobbing, ensuring the visual skeleton stays in place while world translation is 100% driven by Rapier;
- **Authoritative Rapier Physics**: `AnimationMixer` never touches the world transform. The runtime controller applies extracted horizontal motion through `physics.moveCharacter`, where Rapier's kinematic character controller resolves all collisions;
- **Real Obstacle Collision & Tunneling Prevention**: Solid obstacles clip actual displacement (`appliedDelta < requestedDelta`, `collisionClipped == true`, positive `blockedDelta`), preventing character tunneling even during repeated continuous stepping;
- **Animation Graph Crossfade Ownership**: When crossfading between animation states (e.g. walk -> idle), the incoming target state owns root motion displacement, ensuring that idle stops forward locomotion smoothly without doubling displacement; interrupting walk with hurt immediately halts root motion;
- **Structured Observation**: Live queries expose `entity.model.animation.rootMotion` and `entity.gameplay.rootMotion` with `enabled`, `mode`, `activeClip`, `accumulatedDistance`, `requestedDelta`, `appliedDelta`, `blockedDelta`, and `collisionClipped`;
- **Scene Teardown & Reset**: Scene restarts reset accumulators and character positions back to origin;
- **Full Verification**: 100% pass across full workspace check (`pnpm check`) and packaged Windows binary (`smoke:win` on `KinetraGame.exe`).

### 11. Safe Multi-Instance SkinnedMesh Clone & Shared Asset Lifecycle (P5 Proven)

The multi-instance skinned mesh cloning and shared asset resource lifecycle slice is proven in dev Electron and packaged `KinetraGame.exe`:
- **Template Deduplication**: `ModelTemplateCache` deduplicates concurrent loads and caches parsed GLB scenes so that multiple entities referencing the same `Model.assetId` parse the asset exactly once (`assetTemplateParseCount == 1`);
- **Skeleton Isolation via SkeletonUtils.clone**: Every cloned entity instance receives its own unique `Skeleton` instance with independent `Bone` object references and transform hierarchies, completely avoiding bone transforms or mixer bindings leaking across entities;
- **Independent Mixers & Animation Graphs**: Each entity instance manages its own `AnimationMixer` and animation graph session. One instance can play walk/crossfade while another instance plays idle on the exact same asset without cross-talk;
- **Baked Retarget Clip Sharing**: The exact same baked retarget clip definition (`THREE.AnimationClip`) can be played simultaneously across multiple target instances with independent playback times and phase offsets;
- **Independent Root Motion Sessions**: Multiple instances using root-motion clips drive their own Rapier character bodies independently. One mover can step forward and accumulate distance while the other remains stationary;
- **Material Isolation & Texture/Geometry Sharing**: Clones materials per instance (`material.clone()`) to allow independent color/opacity mutations without leaking, while safely sharing underlying `BufferGeometry` and GPU textures;
- **Reference-Counted GPU Resource Disposal**: GPU resources (geometries and textures) are reference-counted (`refCount`). Geometries and textures are preserved as long as at least one instance exists (`refCount > 0`), and cleanly disposed only when `refCount === 0`. Detaching Entity A leaves Entity B running cleanly without disposed buffer errors;
- **Live Detach & Reattach**: Dynamic IPC commands (`model.detach` and `model.attach`) allow instances to be detached and re-attached on demand, reusing the cached asset template without re-parsing;
- **Structured Observation**: Query API truthfully exposes `model.instance = { instanceId, templateAssetId }`, `model.resourceSharing = { sharedGeometry, sharedTextures, uniqueSkeleton, uniqueMixer }`, and `metrics = { assetTemplateParseCount, instanceCount }`;
- **Complete Verification Suite**: 6-scenario real Electron verification suite (`packages/verification/test/real-skinned-multi-instance.test.ts`) passing against dev Electron and packaged Windows executable `KinetraGame.exe`;
- **Full Verification**: 100% pass across full workspace check (`pnpm check`) and packaged Windows binary (`smoke:win` on `KinetraGame.exe`).

### 12. Hot Reimport & Dependency-Aware Live Reload (P4 Proven)

The deterministic hot reimport and live runtime reload vertical slice is proven in dev Electron and packaged `KinetraGame.exe`:
- **Content-Hash Watcher**: `SourceAssetWatcher` watches disk sources, debounces rapid writes (default 100ms), absorbs atomic file replace workflows, and computes content hashes (SHA-256) so touch events and identical saves trigger zero reimports (NOOP);
- **Deterministic Reimport Service**: `AssetReimportService` executes deterministic import recipes (`GlbDirectImporter`), performs strict GLB validation (`validateGlbHeader`), writes new artifacts to temporary staging files, and atomically replaces target artifact files only after successful validation;
- **Failure Rollback & Isolation**: When corrupt or invalid source bytes are provided, reimport validation fails safely, the temporary file is discarded, the existing artifact on disk remains intact, the `AssetDatabase` record is preserved at the previous valid fingerprint, and the live running model in Electron remains unaffected;
- **Transitive Dependency Invalidation**: `AssetDatabase.invalidationSet(assetId)` walks dependency edges in reverse topological order (`A <- B <- C` yields invalidation set `["A", "B", "C"]`), invalidating only affected dependents while unrelated assets (`D`) remain untouched;
- **Template Cache Invalidation & Single Re-Parse**: `ModelTemplateCache.invalidate(assetId)` and `resolveNewTemplate(assetId, resolver)` safely clear stale cached templates and parse updated GLB bytes once across all dependent entities (`metrics.assetTemplateParseCount` increments exactly once across multiple entities);
- **Live Entity Reload without Electron Restart**: `ThreeSceneRuntime.reloadAsset(assetId, resolver)` dynamically swaps entity instances without restarting Electron or destroying the scene. It preserves entity IDs, local/world transforms, Rapier physics colliders, and cleanly tears down old `AnimationMixer`s/clips before re-initializing animation graphs;
- **Multi-Instance Synchronized Reload**: Multiple entities sharing the same asset reload together in a single operation, updating their bounding boxes and revisions synchronously while unrelated entities remain at their prior revision;
- **Structured Observation**: Query API truthfully exposes `model.assetFingerprint`, `model.templateRevision`, `metrics.assetTemplateParseCount`, and `assets.byId[assetId] = { assetId, sourceHash, fingerprint, importStatus, revision }`;
- **Comprehensive Real Electron Verification Suite**: 5-scenario real Electron acceptance suite (`packages/verification/test/real-hot-reimport.test.ts`) proving all 22 verification points with valid PNG frame capture;
- **Full Verification**: 100% pass across full workspace check (`pnpm check`) and packaged Windows binary (`smoke:win` on `KinetraGame.exe`).

### 13. Real Blender Source Hot Reimport Gate (P4 Production Asset Pipeline Gate Proven)

The full authoring-to-runtime production asset loop is closed and proven across real Blender CLI execution, headless `.blend` modification, topological dependency rebuild, and live Electron runtime reload:
- **Headless Blender Source Modification**: Python script `packages/blender-bridge/python/modify_fixture.py` opens, scales, modifies, and saves `.blend` authoring files headlessly without GUI automation, genuinely altering the binary SHA-256 content hash;
- **Engine-Owned BlenderGlbImporter**: `@kinetra/blender-bridge` exports `BlenderGlbImporter` implementing `@kinetra/asset-pipeline`'s `AssetImporter` interface. It executes Blender headless export with staging files, validates output GLB magic and headers, parses export manifests, and outputs immutable artifact bytes;
- **Topological Dependency Rebuild**: `AssetDatabase.dependentsInRebuildOrder` and `rebuildOrder` compute exact topological dependency traversals (dependencies before dependents, e.g. `asset_z <- asset_a <- asset_m` rebuilds `z`, then `a`, then `m`) with deterministic alphabetical tie-breaking rather than naïve lexical sorting;
- **Cascading Fingerprint Propagation**: `AssetReimportService.reimportWithDependents` cascades newly computed fingerprints through downstream dependents via `importFingerprint({ dependencyFingerprints })`, rebuilding only stale dependents and leaving unrelated assets untouched;
- **Partial Failure & Block Semantics**: Structured `DependencyRebuildResult` tracks `rebuilt`, `failed`, `blocked`, and `unaffected`. If an intermediate dependent fails, downstream dependents are cleanly blocked from rebuilding, while the root and unaffected assets remain authoritative;
- **Integrated AssetHotReloadCoordinator**: High-level coordinator service wires `SourceAssetWatcher` -> `AssetReimportService` -> dependency rebuild -> runtime publication (`probe.updateAsset`) -> live entity reload (`probe.reloadAsset`) without manual test glue;
- **Normalized Transactions & NOOP Protection**: Normalizes filesystem events into a single atomic reload transaction (`AssetHotReloadTransaction`), and absorbs touch-only/identical content updates without invoking Blender or reloading runtime entities;
- **Live Electron Verification**: Real Electron acceptance suite (`packages/verification/test/real-blender-hot-reimport.test.ts`) verifies live multi-instance entity swapping across a single continuous Electron process without restart, preserving entity IDs, world positions, and WebGL rendering with valid PNG capture;
- **Failure Rollback & Repair**: Importer failures rollback cleanly leaving live entities running on last-known-good, and subsequent repaired source saves reimport and recover automatically;
- **Blender DCC Boundary**: Blender remains strictly an authoring tool. Packaged shipping binaries (`KinetraGame.exe` and Linux `KinetraGame`) have zero Blender dependencies;
- **P4 Execution Boundary Clarification**: The P4 production asset pipeline has two distinct proofs: (1) Real headless Blender CI workflow (`.github/workflows/blender-pipeline.yml`) proving real `.blend` authoring source modification, CLI execution, and deterministic GLB export; and (2) Real Electron live hot reimport (`packages/verification/test/real-blender-hot-reimport.test.ts`), which operates inside the injected runner probe boundary to reimport, rebuild dependencies, publish runtime updates, and reload live entity instances without restarting the running Electron process.

### 14. Perceptual Visual Verification + Structured Vision Critique Vertical Slice (P8 Proven)

The engine-owned perceptual visual verification and vision critique slice is proven in dev Electron and packaged `KinetraGame.exe`:
- **Engine-Owned Perceptual Visual Analysis (`@kinetra/verification`)**: Zero-native-binary pure TypeScript implementation (`pngjs`) providing deterministic `calculateVisualEvidence` to produce `VisualFrameEvidence` (`sha256`, `width`, `height`, `meanLuminance`, `luminanceVariance`, `entropy`, 64-bit dHash `perceptualHash`, Sobel `edgeDensity`, and `opaquePixelRatio`);
- **Blank Frame Detection (`detectBlankFrame`)**: Distinguishes intentional scenes from solid/dark/transparent or low-entropy empty canvases with machine-readable failure diagnostics;
- **Configurable Perceptual Comparison (`compareVisualFrames`)**: Compares frames using dHash Hamming distance, changed pixel ratios with configurable thresholds, and mean absolute differences;
- **Additive Acceptance Manifest Steps**: Strictly additive extension of `AcceptanceStep` without breaking existing manifests:
  - `capture.frame`: captures and saves named frames to memory and optionally to disk (`saveArtifact: true`);
  - `assert.visualNotBlank`: verifies frame is non-blank;
  - `assert.visualSimilarity`: asserts perceptual match within explicit tolerances (`maxChangedPixelRatio`, `maxPerceptualHashDistance`, `maxMeanAbsoluteDifference`);
  - `assert.visualDifference`: asserts visual change has occurred (`minChangedPixelRatio`, `minPerceptualHashDistance`);
  - `critique.visual`: passes captured frame to a critique provider;
- **Direct Canvas Frame Capture**: Three.js WebGLRenderer in the player runtime enables `preserveDrawingBuffer: true`, allowing direct synchronous canvas capture via `toDataURL("image/png")` to eliminate stale compositor frames and window visibility lag on Windows and Linux;
- **Controlled Visual Regression Proof**: A camera orientation defect produces a frame that passes non-visual checks (`state.byName.TargetCube.model.loaded == true`, `running == true`, `assert.logAbsent`, `assert.screenshotValidPng`), but fails `assert.visualSimilarity` with machine-readable diagnostic values (`visual.perceptualMismatch`), while `assert.visualDifference` passes and repairing the camera passes similarity;
- **Real Arena Visual Verification**: Verifies baseline non-blank rendering, same-state recapture stability, and active player movement across the camera registering perceptual difference (`arenaStart` vs `arenaMoved`);
- **Provider-Neutral Vision Critique Hook**: Interface `VisualCritiqueProvider`, structured report schema `VisualCritiqueReport`, deterministic `FakeVisualCritiqueProvider`, and error isolation ensuring third-party provider failures do not crash the engine runtime;
- **Truthful Claim**: Provider-neutral vision critique hook proven; authenticated live multimodal AI critique is not yet proven;
- **Packaged Windows Verification**: Packaged executable smoke test (`smoke:win` on `KinetraGame.exe`) executes `real-visual-verification.test.js` against the real packaged player.

### 15. Runtime Performance Telemetry + Acceptance Budget Gate (P7/P8 Proven)

The engine-owned runtime performance telemetry and acceptance budget gate slice is proven across dev Electron and packaged `KinetraGame.exe`:
- **Renderer Capture Mode Boundary**: Clear, explicit separation between normal performant shipping renderer (`captureMode: "performance"`, `preserveDrawingBuffer: false`, shipping default) and visual verification capture (`captureMode: "visual"`, `preserveDrawingBuffer: true`). Both modes are truthfully reported through `probe.getHostInfo().captureMode` and `probe.query("renderer")`;
- **Engine-Owned Evidence Model (`RuntimePerformanceEvidence`)**: Captures sample count, warmup count, execution mode (`stepped` vs `continuous`), percentiles (`p50Ms`, `p95Ms`, `p99Ms`, `maxMs`) for frame, simulation, and render CPU times, alongside authoritative Three.js renderer metrics (`drawCalls`, `triangles`, `geometries`, `textures`), scene metrics (`entityCount`, `componentCount`), and physics stats (`rigidBodyCount`, `colliderCount`);
- **Deterministic Percentile Interpolation**: Pure TypeScript `calculatePercentiles` using linear rank interpolation `(p / 100) * (len - 1)` with exact floor/ceil weights, ensuring strictly monotonic percentiles (`p50Ms <= p95Ms <= p99Ms <= maxMs`);
- **Additive Acceptance Manifest Steps**:
  - `performance.sample`: warms up runtime and collects frame/simulation/render CPU timings and peak Three.js metrics over specified sample frames (`sampleCount`, `warmupCount`);
  - `assert.performanceBudget`: evaluates collected evidence against structured budget criteria with optional platform overrides (`windows`, `linux`);
- **Grouped Machine-Readable Budget Violations**: Emits structured `performance.budgetExceeded` violation codes detailing `metric`, `actual`, `budget`, `comparator`, and `platform`;
- **Controlled Structural Regression Proof**: A deliberate 35-box scene structurally regresses draw calls and fails acceptance (`renderer.drawCalls actual 37 exceeds max 15`), while repairing the scene to 2 boxes passes acceptance with 4 draw calls;
- **Resource Lifecycle Stability**: 10 repeated scene start/stop cycles prove GPU geometries, textures, and entities clean up deterministically with zero resource leaks;
- **Multi-Instance Template Parse Deduplication**: Multi-instance assets verify `assetTemplateParseCount == 1` across instances under continuous performance sampling;
- **Post-Sampling Visual Continuity**: Demonstrates that sampling does not poison rendering; a subsequent visual frame can be captured and verified as a valid PNG;
- **MCP Server Acceptance Tool Integration**: `test.runAcceptance` runs performance sample and budget gate steps over in-memory transport;
- **Packaged Windows Verification**: Packaged executable smoke test (`smoke:win` on `KinetraGame.exe`) executes `real-performance.test.js` verifying budget enforcement and clean teardown with zero orphan processes.

### 16. Locomotion Blend Spaces (P5, PR #69 contract + PR #70 runtime)

- **Pure contract** (`@kinetra/animation/blend-space`): schema-versioned `BlendSpace1DDefinition` / `BlendSpace2DDefinition`, `validateBlendSpace` returning `anim.blendSpace.*` diagnostics with remediation, deterministic `evaluateBlendSpace1D/2D` (1D linear with end clamping; 2D cartesian gradient-band interpolation; weights normalised to 1, locale-independent ordering, nearest-sample fallback) and `evaluateBlendSpace` reading `AnimationGraphMachine.getParameters()`;
- **Runtime** (`@kinetra/renderer-three`): `BlendSpacePlayback` driven by `ThreeSceneRuntime.playBlendSpace(entityId, space, { input, speed })` / `setBlendSpaceInput(entityId, input)`; clips of different lengths are phase-synced, errors are atomic and structured, direct clip playback takes over cleanly, and `reloadAsset` restores the blend space. Player bridge: `animation.blendSpace.play` / `animation.blendSpace.setInput`;
- **Proof**: `packages/animation/test/blend-space.test.ts`, `packages/renderer-three/test/blend-space.test.ts`, real Electron `packages/verification/test/real-blend-space.test.ts` (in the verification `test` script);
- **Since then**: graph states that play a blend space, with crossfades into and out of it, landed in PR #146 (`graph-blend-space.test.ts` in animation and renderer-three, real Electron `real-graph-blend-space.test.ts`);
- **Not done**: blend-space root motion, packaged-binary run.

### 17. Morph Targets by Semantic Name (P5, PR #72)

- **Pure contract** (`@kinetra/animation/morph-targets`): name catalog over all meshes (a name shared by several meshes is one value), all-or-nothing `validateMorphWeightRequest` with `anim.morph.*` diagnostics (unknown target with case-sensitivity hint, non-finite, out of `[0, 1]`);
- **Runtime**: engine-owned `MorphTargetController` per model instance; overrides are re-applied after the mixer so they win over clip tracks, clearing restores authored defaults, overrides survive `reloadAsset` (dropped names reported as `animation.morphOverridesDropped`). Observable as `model.morphTargets`. Bridge: `animation.setMorphWeights` / `animation.clearMorphWeights`; game scripts get the same calls;
- **Proof**: `packages/animation/test/morph-targets.test.ts`, `packages/renderer-three/test/morph.test.ts`, real Electron `real-morph-targets.test.ts` (in the verification `test` script), fixture `createSyntheticMorphGlb`;
- **Not done**: game-script path test, packaged run, Blender shape-key export, morph crossfade inside graphs.

### 18. Inverse Kinematics (P5, PR #71 solver + PR #74 runtime adapter + PR #75 bridge)

- **Pure solver** (`@kinetra/animation/ik`): `IkChainDefinition` (schemaVersion 1, `two-bone` | `fabrik`), `validateIkChainDefinition` (`ik.*` diagnostics with severity), analytic `solveTwoBoneIk` with pole vector and exact bone-length preservation, `solveFabrikIk` with bounded iterations (`IK_MAX_ITERATIONS_LIMIT`), `solveIkChain`, `computeBoneAimRotations`;
- **Runtime adapter**: `IkController` (renderer-three) applies solved chains to named bones after `mixer.update()` via `ThreeSceneRuntime.setIkChains` / `setIkTarget` / `clearIkTarget`;
- **Bridge**: `animation.ik.setChains` / `animation.ik.setTarget` / `animation.ik.clearTarget` in the player;
- **Proof**: `packages/animation/test/ik.test.ts`, `packages/renderer-three/test/ik.test.ts`. real Electron `packages/verification/test/real-ik-bridge.test.ts` covers structured error paths only, on a model without bones (registered in the verification `test` script since #118);
- **Not done**: IK on a real skinned model through the bridge, command-bus/MCP exposure, foot-planting helpers. (Follow-up fixes on main make IK run for models without animation clips too.)

### 19. GLB Compression Policy + Meshopt Runtime Decoding (P4, PR #73)

- `@kinetra/asset-pipeline`: `inspectGlbCompression`, `evaluateCompressionPolicy`, `checkGlbCompression` read only the GLB JSON chunk, never throw, and report Meshopt/Draco/KTX2 usage, unknown required extensions, undeclared compression, and large uncompressed geometry;
- `@kinetra/renderer-three`: `createRuntimeGltfLoader` decodes `EXT_meshopt_compression`; `RUNTIME_DECODER_CAPABILITIES` and `RUNTIME_GLTF_DECODERS` are kept equal by a test;
- **Proof**: `packages/asset-pipeline/test/compression.test.ts`, `packages/renderer-three/test/compressed-gltf.test.ts` (Node);
- **Not done**: an offline Meshopt encode step in the pipeline, Draco/KTX2 decoders, Meshopt assets inside the packaged player.

### 20. Animation Events Contract (P5, PR #180, issue #90 part 1)

- **Pure contract** (`@kinetra/animation/events`): `normalizeAnimationEvents` / `parseAnimationEventsText` validate `{clip, time, name, payload}` definitions with `animation.events.*` diagnostics (never throw); `createClipEventTracker` reports the events a playback head crossed (forward `(from, to]`, reverse `[to, from)`, loop wraps fire once per crossing, per-call fire cap with `truncated`);
- **Proof**: `packages/animation/test/events.test.ts` (pure Node; the animation `test` script runs `dist/test/*.test.js`);
- **Not done**: `ThreeSceneRuntime` does not drive trackers from its mixers, no `context.animation.onEvent` for scripts, no runtime log entry or bridge command, no real Electron test. Issue #90 stays open until that wiring lands.

### 21. Executable Documentation (docs)

- `pnpm check:docs` (`scripts/check-doc-examples.mjs`, part of `pnpm check`) compiles every ```` ```ts doc-check ```` fence in the READMEs and guides with the owning package's tsconfig and runs it with Node, so a README example that no longer typechecks or asserts wrongly fails CI;
- Package READMEs with checked examples: animation, asset-pipeline, audio, command-bus, core, input, navigation-recast, physics-rapier, project-model, renderer-three, save-state, verification, plus `docs/guides/AI_AGENT_MCP.md` (tool table from `packages/mcp-server/src/server.ts`);
- **Not done**: READMEs for blender-bridge (short), desktop-build, mcp-server (no checked example yet), apps/player and apps/editor; TSDoc on every public export.

## Completion definition

Kinetra is not "done" when:
- TypeScript builds;
- a Three.js scene looks nice;
- the editor opens;
- a web demo works.

The target proof is:

```text
blank project
 -> AI authors game through structured tools
 -> assets imported deterministically
 -> runtime runs
 -> semantic tests pass
 -> Windows executable is built
 -> packaged executable launches
 -> packaged acceptance suite passes
 -> Linux x64 portable KinetraGame is a separate packaged proof, not a substitute for KinetraGame.exe
```

## Do not infer implementation status from folder names

Some package folders were created early as architecture placeholders. Always verify status in `docs/STATUS.md`, CI and the relevant package tests before assuming a subsystem exists.
