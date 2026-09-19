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
| P7 physics/navigation/perf | WIP | PR #26 contains Rapier/Recast adapters. Real CI behavior exposed unresolved character-controller/navmesh assumptions. Not merge-ready. |
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

What exists:
- acceptance manifest;
- semantic input steps;
- state assertions;
- log absence assertions;
- metric budgets;
- exact screenshot hash primitive;
- process smoke runner.

- real runtime probe adapter;
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
- connecting P8 verification runner to live `ElectronRuntimeHost`;
- complex model/mesh loading through asset pipeline into player runtime.

## Open implementation references

### PR #29 — P2 Electron runtime bridge

Superseded by `feat/p2-real-runtime-bridge`. Proven on Windows with deterministic tests, real PNG capture, and clean teardown. Safe to close after branch review.

### PR #26 — P7 Rapier/Recast

Known real test findings included:
- character-controller collision query did not behave as assumed;
- Recast closest-point fixture used assumptions incompatible with actual query extents.

Do not "fix" by weakening the acceptance goal. Repair the adapter/test geometry using documented library behavior.

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
