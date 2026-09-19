# AGENTS.md

This repository is designed to be developed heavily by coding agents.

## Start here — required reading order

Before changing code, read these files in order:

1. `docs/HANDOFF.md`
2. `docs/STATUS.md`
3. `VISION.md`
4. `ARCHITECTURE.md`
5. `docs/architecture/SYSTEM_MAP.md`
6. the relevant architecture document under `docs/architecture/`
7. `ROADMAP.md`
8. `LICENSE-POLICY.md`

`docs/STATUS.md` is the current implementation source of truth. A package directory, branch, issue, or PR existing does **not** mean that feature is production-ready.

## Prime directive

**Kinetra is an AI-operated game engine. Do not optimize the architecture around human editor convenience at the expense of agent control, observability or verification.**

The primary loop is:

```text
author -> run -> observe -> test -> fix -> package -> verify packaged build
```

## Hard architectural rules

- Do not make `THREE.Object3D` the project database.
- Do not let React/editor code directly mutate authoring state.
- Do not expose a giant untyped "execute arbitrary JSON" surface as the primary MCP API.
- All authoring mutations go through the typed command bus.
- Runtime state and authoring/project state are separate.
- Stable IDs are required for entities, assets, prefabs, scenes and tests.
- Project formats are schema-versioned.
- Destructive multi-object operations require transaction/checkpoint semantics.
- Every MCP mutation supports structured success/failure and should be testable without visual inspection.
- Prefer semantic input actions such as `player.jump` over physical key emulation in automated tests.
- The packaged executable is a test target.
- Do not add GPL/AGPL-derived implementation code unless a maintainer explicitly changes the reuse policy.
- Do not treat an open experimental PR as accepted architecture. Check `docs/STATUS.md` first.

## Current development mode

The project is intentionally paused at a **documentation/architecture handoff point**.

Do not continue broad feature implementation automatically. The next coding agent should:

1. choose one open phase;
2. read its issue + status notes;
3. inspect existing WIP branches/PRs only as references;
4. create a fresh bounded plan;
5. prove one vertical slice at a time.

If a WIP branch has failing CI, prefer extracting the useful contract into a fresh branch rather than piling fixes onto a long experimental branch.

## AI-friendly implementation style

Prefer:

- small packages with explicit public contracts;
- validation at boundaries;
- deterministic IDs in fixtures/tests;
- structured errors with codes and remediation hints;
- query APIs with field selection and pagination;
- command diffs rather than full project dumps;
- deterministic test scenes;
- dependency injection around renderer/platform bridges;
- build-time asset processing over expensive runtime magic.

Avoid:

- implicit global state;
- side-effectful getters;
- giant context objects;
- hidden editor-only state required for game correctness;
- opaque binary project data;
- non-deterministic asset import when a deterministic recipe is possible.

## Required verification for implementation PRs

At minimum, a PR should prove the layer it changes. Depending on scope:

- type/schema tests;
- command transaction/undo tests;
- serialization round-trip;
- asset import golden test;
- runtime semantic assertion;
- screenshot only when visual behavior matters;
- packaged-exe smoke test for build/platform changes.

"Compiles" is not a sufficient completion claim for gameplay or runtime features.

## Environment rule

Do not claim an environment is required until the task reaches a boundary listed in `docs/ENVIRONMENT_BOUNDARIES.md`.

Many things that look environment-dependent can still be proven in GitHub Actions:
- Blender headless export;
- Node/WASM libraries;
- Windows Electron packaging;
- deterministic unit/integration tests.

## Donor repositories

Permissive repositories may be used only when license obligations are preserved and the integration fits Kinetra's contracts. Copyleft repositories listed as reference-only are for architectural study, not code copying.

See `LICENSE-POLICY.md`.

## Scope discipline

Do not build these early unless a milestone explicitly requires them:

- multiplayer;
- terrain editor;
- shader graph;
- cinematic timeline;
- marketplace;
- plugin marketplace;
- console/mobile exporters;
- custom native JS runtime;
- Unity-sized visual editor.

The first priority remains the autonomous loop: author -> run -> observe -> test -> fix -> package.
