# AGENTS.md

This repository is designed to be developed heavily by coding agents.

## Prime directive

**Kinetra is an AI-operated game engine. Do not optimize the architecture around human editor convenience at the expense of agent control, observability or verification.**

Before making a non-trivial change, read:

1. \`VISION.md\`
2. \`ARCHITECTURE.md\`
3. \`LICENSE-POLICY.md\`
4. relevant docs under \`docs/architecture/\`
5. \`ROADMAP.md\`

## Hard architectural rules

- Do not make \`THREE.Object3D\` the project database.
- Do not let React/editor code directly mutate authoring state.
- Do not expose a giant untyped "execute arbitrary JSON" surface as the primary MCP API.
- All authoring mutations go through the typed command bus.
- Runtime state and authoring/project state are separate.
- Stable IDs are required for entities, assets, prefabs, scenes and tests.
- Project formats are schema-versioned.
- Destructive multi-object operations require transaction/checkpoint semantics.
- Every MCP mutation supports structured success/failure and should be testable without visual inspection.
- Prefer semantic input actions (\`player.jump\`) over physical key emulation (\`Space\`) in automated tests.
- The packaged executable is a test target.
- Do not add GPL/AGPL-derived implementation code unless a maintainer explicitly changes the reuse policy.

## AI-friendly implementation style

Prefer:

- small packages with explicit public contracts;
- JSON-schema/Zod-like validation at boundaries;
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

## Donor repositories

Permissive repositories may be used only when license obligations are preserved and the integration fits Kinetra's contracts. Copyleft repositories listed as reference-only are for architectural study, not code copying.

See \`LICENSE-POLICY.md\`.

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

The first priority is the autonomous loop: author → run → observe → test → fix → package.
