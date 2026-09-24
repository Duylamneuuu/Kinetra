# Roadmap

Kinetra's roadmap is ordered by dependency and proof, not by editor spectacle.

> **Status note (2026-09-24):** This file describes intended phases. It is not the implementation source of truth. Read [docs/STATUS.md](./docs/STATUS.md) before coding.

## Current checkpoint

- **Linux x64 Runtime Milestone — COMPLETE.** Dev Electron, packaged `KinetraGame` x64, the semantic bridge, gameplay and combat acceptance, save/load, package smoke, teardown, and the Linux pull-request CI workflows are proven. See `docs/STATUS.md`.
- That milestone does not include ARM64, AppImage, Flatpak, Snap, deb/rpm, Wayland certification, Steam, signing, an installer, or auto-update. Do not continue Linux infrastructure work unless a real requirement appears.
- Linux proof does not replace Windows `KinetraGame.exe` proof.
- P0 and P1 foundation gates were completed. P2 real Electron bridge and P7 physics/navigation slices are on `main`, not only on experimental branches.
- P4, P5, P6, P8, and P10 have proven runtime slices on `main`. Their full production gates are still broader than those slices. P10 Arena combat is on `main`; it is not a finished game.
- P3 observer editor and P9 distribution remain unaccepted. PR #22, PR #26, PR #28, and PR #29 are references, not the Linux milestone.

## Phase 0 — Runtime contracts

**Goal:** establish the architecture that every later system depends on.

Deliverables:
- monorepo boundaries;
- project schema/versioning;
- stable IDs;
- entity/component project model;
- scene serialization;
- command/query bus;
- transactions;
- revision preconditions;
- dry runs;
- undo/redo tokens;
- structured diffs;
- minimal Three.js runtime projection;
- schema migration test harness.

**Gate:** a deterministic scene can be authored only through commands, serialized, reloaded, instantiated, modified, undone and diffed.

## Phase 1 — Windows build spike

Deliverables:
- minimal Vite player build;
- Electron game shell;
- fullscreen/window modes;
- local save/config path abstraction;
- clean separation of editor/player;
- CI packaging smoke test.

**Gate:** a Three.js scene becomes a standalone Windows game artifact and launches outside dev mode.

## Phase 2 — AI-native vertical slice

Deliverables:
- MCP server;
- scene/entity/component queries;
- typed mutation tools;
- runtime start/stop/query/log tools;
- semantic input injection;
- frame capture;
- provider-neutral tool schemas;
- compact engine guide.

**Gate:** an agent creates a small scene, runs it, observes state/screenshots, finds a deliberate defect and fixes it without GUI automation.

## Phase 3 — Observer editor MVP

Deliverables:
- Electron/React editor;
- viewport;
- hierarchy;
- schema-generated inspector;
- selection/gizmo;
- asset browser;
- Monaco;
- console;
- Play/Stop;
- command history.

**Gate:** human UI performs the same mutations as MCP and contains no privileged hidden authoring path.

## Phase 4 — Production asset pipeline

Deliverables:
- asset IDs/database;
- source/imported/generated separation;
- Blender->GLB recipes;
- validation;
- thumbnails/previews;
- dependency graph;
- hashes/cache;
- hot reimport;
- glTF processing/optimization policy;
- compression/texture policy.

**Gate:** modifying a source Blender file causes deterministic, validated reimport and only invalidates dependent artifacts.

## Phase 5 — Character and animation

Deliverables:
- skinned mesh lifecycle;
- skeleton signatures/profiles;
- safe cloning;
- clip browser;
- retargeting;
- import-time baked retarget cache;
- morph targets;
- root-motion extraction;
- animation events;
- text animation graph;
- state transitions/blending.

**Gate:** a character imported from Blender and an external humanoid animation source can be normalized, retargeted, driven by physics/input and verified automatically.

## Phase 6 — Core game systems

Deliverables:
- prefabs + overrides;
- script lifecycle;
- named input actions/axes;
- gamepad/remapping;
- audio mixer/buses;
- scene lifecycle;
- game UI layer;
- settings;
- save/load + migrations.

**Gate:** a small complete game loop survives restart and save/load and is playable with keyboard and controller.

## Phase 7 — Physics, navigation and performance

Deliverables:
- Rapier rigid bodies/colliders;
- authoritative character motor;
- collision layers;
- navmesh bake/query/crowds;
- LOD;
- instancing/batching hooks;
- resource lifetime accounting;
- performance profiler/metrics.

**Gate:** reference scene meets deterministic physics/navigation assertions and defined performance budgets.

## Phase 8 — Verification platform

Deliverables:
- acceptance manifest;
- deterministic runtime scenarios;
- semantic player bot;
- state assertions;
- log assertions;
- screenshot regression;
- visual AI critique hook;
- performance gates;
- packaged-exe smoke suite.

**Gate:** an agent cannot mark a shipping task complete unless the required acceptance manifest passes.

## Phase 9 — Distribution

Deliverables:
- release packaging;
- installer/portable layouts;
- code-signing hooks;
- platform bridge;
- Steam bridge abstraction;
- SteamPipe scripts/docs.

**Gate:** CI can produce a release candidate whose packaged executable passes the shipping smoke suite.

## Phase 10 — First complete reference game

Target: a deliberately modest 20–40 minute single-player 3D action/adventure slice.

It must force the engine to prove:
- boot/main menu;
- animated 3D player;
- camera/physics;
- enemies + navmesh;
- real gameplay loop;
- UI/audio;
- pause/settings;
- save/load;
- win/lose;
- controller;
- credits;
- executable packaging;
- automated play/acceptance.

**Gate:** the packaged build passes the complete acceptance suite.

## Explicitly deferred

Multiplayer, terrain authoring, shader graphs, cinematics, marketplace/plugin ecosystem, console export, mobile export and a custom native Three.js runtime stay out until the complete-game loop is proven.
