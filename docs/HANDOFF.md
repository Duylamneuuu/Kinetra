# Kinetra handoff — 2026-09-24

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

## Current milestone

**Linux x64 runtime milestone complete.**

`main` is `8e05113`. The Linux implementation is already merged. Do not reopen it as new infrastructure work.

### Proven

- Dev Electron on Linux x64 under xvfb (`smoke:linux`, PR #48).
- Packaged Linux x64 `KinetraGame` (`package:linux`, `smoke:linux:packaged`, PR #50).
- The existing semantic stdio runtime bridge. There is no second protocol.
- Real gameplay acceptance on dev Electron (PR #49 `real-electron-tests`).
- Combat acceptance on dev Electron (PR #49) and on the packaged binary (`smoke:linux:packaged`).
- Save/load across processes on dev Electron and on the packaged binary.
- Linux package smoke and clean process teardown.
- Linux CI workflows on those pull requests: `linux-player.yml`, `linux-packaged-player.yml`, `linux-verification.yml`.

Push of `8e05113` to `main` ran Foundation checks only. Linux workflows trigger on pull requests, not on every push.

### Not proven

- ARM64
- AppImage, Flatpak, Snap, deb, or rpm
- Wayland-specific certification
- Steam
- Linux signing, installer, or auto-update

Windows `KinetraGame.exe` proof is separate. Do not treat a Linux run as Windows proof.

### Next development direction

Return to the core Kinetra roadmap on the developer machine. Do not continue Linux infrastructure work unless a real requirement appears.

Recommended order from here:

1. Use `docs/STATUS.md` as the implementation source of truth.
2. Pick one non-Linux roadmap gap (authoring, discovery, or a still-unproven gameplay contract).
3. Branch from current `main`.
4. Do not stack another Linux packager, display server, or runtime protocol.

### Unmerged work that still needs maintainer action

These are not part of the closed Linux milestone. Do not merge them just to finish Linux.

- **PR #53** — canonical Arena `.kinetra.json` snapshot. Open, mergeable, CI green including Linux smoke, packaged player, and real-Electron tests. Boot still does not load that file. Optional authoring fixture, not a Linux blocker.
- **PR #47** — Cloud Agent environment. Draft. Foundation checks only.
- **PR #28** — Windows release and Steam contracts. Draft. Not Linux distribution, and not proven with credentials.
- **PR #29** — old Electron bridge experiment. Conflicts with `main`. Superseded by the merged runtime. Do not merge.
- **PR #26** — old Rapier/Recast experiment. Conflicts with `main` and failed CI. Superseded by the merged physics and navigation slices. Do not merge.

Many `cursor/*` branches exist from later cloud sessions (diagnostics, catalogs, launch-policy notes, starter projects). They are not merged and are not required to close this milestone. Inspect `docs/STATUS.md` before treating any of them as accepted.

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

## Why this handoff exists

The Linux x64 runtime milestone is complete on `main`. The next agent should continue the core roadmap locally and should not start another Linux packaging or display-server loop.

## Recommended continuation order

### 1. P2 runtime bridge is already proven

Dev Electron, the semantic bridge, and the Linux x64 packaged player are on `main`. Do not rebuild that bridge. The observer editor is still not the next required step unless a milestone explicitly asks for it.

### 2. Rebuild/port P3 observer editor on top of accepted P2

The editor must call the same command bus as AI tools. It must not become a second hidden authoring path.

### 3. P7 physics/navigation slices are already on main

Rapier and Recast runtime slices are proven in Electron. Do not merge PR #26. Crowds, LOD, and performance extras are still out of scope.

### 4. P8 acceptance runner is already on main

P8 MCP acceptance execution (`test.runAcceptance`) and packaged-runtime verification are proven against dev Electron and `KinetraGame.exe`. Linux packaged acceptance is covered by the closed milestone above.

### 5. Reference game (P10 Slice 1, Slice 2, Slice 3, Slice 4 Proven)

The bounded reference-game vertical slice ("Kinetra Arena") is proven on top of P2, P6, P7, and P8 against both dev Electron and packaged `KinetraGame.exe`. It verifies the autonomous loop: author -> run -> observe -> test -> fix -> package -> verify packaged build.
Slice 1 proved core movement, NavMesh chase, win/lose, audio, and save/load.
Slice 2 proved the player-facing shell: Main Menu, HUD, Pause, Settings, Gamepad snapshot provider, and Result screens.
Slice 3 proved the repeatable gameplay loop: explicit run status (`idle` -> `active` -> `completed`/`failed`), 3 structured deterministic objectives (Security Console, Power Core, Escape Goal), HUD projection with completed count, Lockdown Survival Challenge with 1.6x enemy speed boost, and multi-process save/restore preserving exact progress.
Slice 4 proved the combat foundation: deterministic player combat action (`player.attack`), cooldown and 2.0m range check, structured hit/miss events, bidirectional damage model (player damages enemy, enemy damages player, health bounded in [0, 3]), enemy defeated state halting navigation and attacks, combat audio feedback, multi-process save/restore of combat state, and full 5-scenario acceptance against packaged `KinetraGame.exe`.

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
