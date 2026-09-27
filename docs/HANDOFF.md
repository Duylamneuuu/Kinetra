# Kinetra handoff — 2026-09-19

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

Treat the following only as implementation references until re-proven:

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
