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
 
### 6. AI Asset Production (Scenario Vertical Slice Proven)

The external AI asset generation pipeline is proven via the Scenario-to-Kinetra vertical slice:
- Scenario MCP boundary isolated from runtime player;
- Kinetra-owned orchestration skill (`.agents/skills/kinetra-scenario-asset/SKILL.md`);
- Ingestion pipeline with validation, normalization, sha256 content hashing, stable `assetId`, and provider-neutral `AssetProvenance` metadata;
- Real static prop fixture (`examples/reference-game/assets/props/energy-crate.glb`);
- 5-scenario acceptance suite (`packages/verification/test/real-scenario-asset.test.ts`) verifying ingestion, command bus mutation, real Electron WebGL projection, structured model queries, deliberate missing-asset failure resilience, and clean teardown.

### 7. Rigged Character Combat Animation (P10 Slice 6 Proven)

The rigged 3D character combat animation vertical slice is proven against dev Electron and packaged `KinetraGame.exe`:
- Programmatic synthetic rigged character generation (`createSyntheticCharacterGlb`) with `SkinnedMesh`, 7-bone hierarchy (`Hips`, `Spine`, `Head`, `LeftArm`, `RightArm`, `LeftLeg`, `RightLeg`), and 6 combat clips (`idle`, `walk`, `telegraph`, `attack`, `hurt`, `defeat`);
- Canonical rigged character asset fixture (`examples/reference-game/assets/characters/enemy-bot.glb` & `enemy-bot.asset.json`) with Scenario provenance;
- Three.js SkinnedMesh and Skeleton projection in the Electron player runtime, populating structured query fields (`entity.model.skinnedMeshCount`, `entity.model.hasSkin`);
- Engine-owned semantic animation layer exposing `context.animation.play(clipName, options)`, `stop()`, `activeClip`, and `playing` to scripts without exposing `THREE.AnimationMixer`;
- Truthful structured gameplay state observation via `entity.gameplay.animation: { activeClip, playing, speed }`;
- Authoritative gameplay/physics ownership: animation drives visual mesh poses in place, while Rapier physics owns character position and combat timings operate independently;
- Deterministic synchronization between `ArenaEnemyController` combat state machine (`chasing` -> `telegraph` -> `attack` -> `hurt` -> `defeat`) and character animation clips;
- 10-scenario real Electron verification suite (`real-character-animation.test.ts`) passing against dev Electron and packaged Windows binary (`KinetraGame.exe`);
- Full regression suite passing all 7 packaged test suites: Acceptance MCP, Arena, Game Shell, Gameplay Loop, Combat, Combat Progression, and Character Animation.

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
