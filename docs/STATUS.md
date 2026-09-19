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
| P4 Blender/asset pipeline | CORE MERGED | Asset DB/hash/dependency/diagnostic core and CI-proven headless Blender -> GLB fixture are on main. Full hot-reimport/thumbnail/compression policy is not finished. |
| P5 animation | CORE MERGED | Skeleton profiles, retarget plans/cache keys, root-motion modes, clip metadata/events and text animation-graph semantics are on main. Real skinned-mesh/AnimationMixer integration remains. |
| P6 complete-game contracts | CORE MERGED | Prefab overrides, script/scene lifecycle, named keyboard/gamepad input/remap, save migrations/settings storage and audio buses are on main. Full game UI/runtime integration remains. |
| P7 physics/navigation/perf | SLICE 1 PROVEN | Rapier physics baseline proven in real Electron runtime via AcceptanceRunner: deterministic fixed-step simulation, gravity fall, floor collision, kinematic character controller clipping, live transform sync. Navigation/Recast remains pending. |
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
- GLB parse/normalization with permissive core dependencies.

Not yet equivalent to a production importer:
- hot reimport daemon/watch;
- thumbnails;
- Meshopt/Draco/KTX2 final policy;
- full dependency-aware runtime reload.

### Animation

What exists:
- semantic humanoid bone mapping;
- skeleton signatures;
- source->target retarget plan;
- retarget cache key;
- root-motion extraction policy;
- text-backed graph/state-machine semantics.

Still missing:
- actual Three.js `AnimationClip` retarget baking;
- safe skinned-mesh clone lifecycle;
- morph-target runtime;
- complete blend/transition adapter.

### Complete-game contracts

What exists:
- prefab template/override semantics;
- deterministic script lifecycle;
- scene lifecycle;
- action-based input + remapping;
- versioned save migration/store contracts;
- hierarchical audio buses.

Still missing:
- integrated runtime UI layer;
- file-backed desktop save adapter;
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
- complex model/mesh loading through asset pipeline into player runtime.

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
Superseded in part by `feat/p7-rapier-physics-slice`, which fixed the character-controller spatial query pipeline initialization and proved deterministic Rapier simulation in the real Electron player runtime. Recast navigation remains to be ported cleanly in a subsequent vertical slice.

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
