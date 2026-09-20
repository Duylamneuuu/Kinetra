# Implementation status

**Snapshot:** 2026-09-19  
**Authoritative base:** `main` at the documentation handoff point.

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
| P2 AI-native runtime bridge | CORE PROVEN | Real Electron/Three.js player runtime bridge with named pipe IPC, project instantiation, live entity query, semantic input injection, structured logs, and real PNG capture verified on Windows. |
| P3 observer editor | WIP | PR #22 is an old stacked implementation reference. Rebuild/port only after P2 is accepted. |
| P4 Blender/asset pipeline | RUNTIME SLICE PROVEN | Asset DB/hash/dependency/diagnostic core on main. Real GLB loading via AssetResolver, Three.js GLTFLoader, structured runtime state query, transform preservation, error logging, and PNG capture proven via AcceptanceRunner in Electron. |
| P5 animation | RUNTIME PLAYBACK SLICE PROVEN | Skeleton profiles, retarget plans/cache keys, root-motion modes, clip metadata and text animation-graph semantics on main. Real GLB animation playback via AnimationMixer, semantic play/stop, deterministic runtime.step simulation advancement, structured observation state (model.animation, model.nodes), and AcceptanceRunner proof verified in live Electron. |
| P6 complete-game contracts | RUNTIME SLICES PROVEN | P6 gameplay script/input + save/load + desktop file storage + audio runtime slices proven: ScriptHost lifecycle (onCreate/onStart/onUpdate/onStop/onDestroy), InputRouter semantic action routing (player.moveRight, player.jump), deterministic frame ordering, truthful structured observation (entity.gameplay), versioned save/load persistence (@kinetra/save-state) with atomic restoration and real file-backed desktop storage (multi-process restart, atomic write, path traversal protection, corrupt save resilience), hierarchical audio mixer (@kinetra/audio) with truthful gain/mute propagation, Web Audio decoding/playback via assetId, and AcceptanceRunner proofs verified in live Electron. Game UI, settings, and broader game loop remain unfinished. |
| P7 physics/navigation/perf | RUNTIME SLICES PROVEN | Rapier physics and Recast navigation baselines proven in real Electron runtime via AcceptanceRunner: deterministic fixed-step simulation, gravity fall, floor collision, kinematic character controller clipping, navmesh generation, pathfinding (findPath), agent navigation, and live transform sync. |
| P8 verification | CORE MERGED | Acceptance manifest/runner, semantic steps, structured state/log/metric checks, screenshot hash primitive and process-smoke primitive are on main. Runtime/MCP/package wiring remains. |
| P9 distribution/Steam | WIP | PR #28 contains release/signing/SteamPipe contracts. Real signing/upload is intentionally outside repo-only proof. |
| P10 reference game | NOT STARTED | Placeholder/issue only. Do not build until P2/P7/P8 integration is stable. |

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
- end-to-end verification via `AcceptanceRunner` and real frame capture.

Not yet equivalent to a production importer:
- hot reimport daemon/watch;
- thumbnails;
- Meshopt/Draco/KTX2 final policy;
- full dependency-aware runtime reload.

### Animation

What has meaningful proof:
- semantic humanoid bone mapping;
- skeleton signatures;
- source->target retarget plan;
- retarget cache key;
- root-motion extraction policy;
- text-backed graph/state-machine semantics;
- programmatic synthetic animated GLB fixture generation (`createSyntheticAnimatedGlb`);
- GLTF animation clip extraction via Three.js `GLTFLoader` in the Electron player runtime;
- encapsulated `THREE.AnimationMixer` management in `ThreeSceneRuntime` behind semantic methods (`playAnimation`, `stopAnimation`, `updateAnimation`);
- semantic command dispatch (`animation.play`, `animation.stop`) over named pipe bridge;
- deterministic simulation advancement via `runtime.step` updating mixer and synchronizing internal node transforms;
- truthful structured runtime state exposing `entity.model.animation` (`clips`, `activeClip`, `playing`, `time`, `duration`) and `entity.model.nodes` (`name`, `position`);
- structured error log `animation.playFailed` on invalid clip requests without runtime crash;
- resource cleanup and zero-leak teardown on scene stop and restart;
- real AcceptanceRunner proof with real PNG frame capture in live Electron.

Still missing:
- actual Three.js `AnimationClip` retarget baking;
- humanoid retargeting / Mixamo / skeleton mapping;
- animation graph runtime and complex blend trees;
- root-motion extraction driving character physics;
- morph-target runtime;
- complete blend/transition adapter;
- safe skinned-mesh clone lifecycle.

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
- end-to-end game loop proof.

### Verification

What has meaningful proof:
- pure acceptance-runner state machine (`AcceptanceRunner`);
- `FakeProbe` execution proof;
- real runtime probe adapter (`KinetraRuntimeProbe`) driving live Electron runtime host;
- semantic input injection (`input`), structured state query (`assert.equal`, `assert.near`), structured log verification (`assert.logAbsent`), and real frame capture (`assert.screenshotValidPng` with magic bytes and size check);
- machine-readable failure reports on deliberate assertion failures;
- clean, leak-free process teardown and lifecycle management;
- process smoke runner for packaged exes.

What remains:
- MCP `test.runAcceptance`;
- packaged-game acceptance wiring;
- optional perceptual/AI visual critique.

### Runtime bridge (P2)

What has meaningful proof:
- Electron player runtime controlled over Windows named pipes (`ElectronRuntimeHost`);
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
- real-time transform synchronization from physics world into Three.js scene graph;
- deterministic stepping command (`runtime.step`) exposed over the runtime bridge;
- full acceptance verification (`real-physics.test.ts`) driving live Electron runtime with real PNG capture and clean teardown.

Still missing:
- raycasting / shape casting query API;
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
