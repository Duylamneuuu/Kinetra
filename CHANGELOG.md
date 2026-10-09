# Changelog

All notable changes merged to `main`, newest first. Kinetra has no tagged releases yet, so entries are grouped by commit date.
Entries are derived from squash-merge commit titles; the PR number links to the full description and verification evidence.
What is actually *proven* (and at which level) is tracked in [`docs/STATUS.md`](docs/STATUS.md), not here.

Maintenance: when a PR merges, add one line under its commit date in the matching section, using the PR title (`ci`/`build`/`chore` go under Maintenance).

## 2026-10-09

### Added

- **orb-run**: foot placement with two-bone IK (slice 4) ([#160](https://github.com/Duylamneuuu/Kinetra/pull/160))
- **physics**: raycast and shapeCast queries with layer filtering ([#155](https://github.com/Duylamneuuu/Kinetra/pull/155))
- **orb-run**: locomotion blend space driven by speed (slice 3) ([#143](https://github.com/Duylamneuuu/Kinetra/pull/143))
- **animation**: graph states that play a blend space, with crossfades into and out of it ([#146](https://github.com/Duylamneuuu/Kinetra/pull/146))
- **examples**: Orb Run acceptance manifests on the engine AcceptanceRunner (slice 2) ([#136](https://github.com/Duylamneuuu/Kinetra/pull/136))
- **examples**: Orb Run dogfood sample, authored over MCP and playable headless ([#86](https://github.com/Duylamneuuu/Kinetra/pull/86))
- **player**: expose IK chains/targets through the runtime bridge ([#75](https://github.com/Duylamneuuu/Kinetra/pull/75))
- **renderer-three**: apply IK solver to skeleton bones after mixer update ([#74](https://github.com/Duylamneuuu/Kinetra/pull/74))
- **assets**: add GLB compression policy and Meshopt decoding in the runtime loader ([#73](https://github.com/Duylamneuuu/Kinetra/pull/73))
- **animation**: add pure two-bone and FABRIK IK solver contract ([#71](https://github.com/Duylamneuuu/Kinetra/pull/71))
- **animation**: drive glTF morph targets by name in the runtime ([#72](https://github.com/Duylamneuuu/Kinetra/pull/72))
- **animation**: play 1D/2D locomotion blend spaces in the runtime with phase sync ([#70](https://github.com/Duylamneuuu/Kinetra/pull/70))
- **animation**: add pure 1D/2D locomotion blend-space contract ([#69](https://github.com/Duylamneuuu/Kinetra/pull/69))

### Fixed

- **mcp-server**: locale-independent scene/entity ordering + service/runtime contract tests ([#156](https://github.com/Duylamneuuu/Kinetra/pull/156))
- **project-model**: keep JSON "__proto__" keys when serializing; add contract + round-trip fuzz tests ([#158](https://github.com/Duylamneuuu/Kinetra/pull/158))
- **asset-pipeline**: canonical JSON hashing no longer collides on __proto__/NaN/Date; reject cycles ([#157](https://github.com/Duylamneuuu/Kinetra/pull/157))
- **save-state**: remove temp file when write/sync fails ([#144](https://github.com/Duylamneuuu/Kinetra/pull/144))
- **renderer-three**: re-bind IK chains after hot reimport and report rejected chains ([#78](https://github.com/Duylamneuuu/Kinetra/pull/78))
- **verification**: fail optional-probe steps with UNSUPPORTED_STEP instead of passing silently ([#142](https://github.com/Duylamneuuu/Kinetra/pull/142))
- **assets**: roll back rejected cyclic upserts, dedupe rebuild-order deps, release re-pointed watcher paths, validate polycount/texture size ([#141](https://github.com/Duylamneuuu/Kinetra/pull/141))
- **mcp-server**: serialize project saves and use unique temp files ([#140](https://github.com/Duylamneuuu/Kinetra/pull/140))
- **blender-bridge**: structured errors, flag-safe paths, drained process output and validated manifest ([#137](https://github.com/Duylamneuuu/Kinetra/pull/137))
- **audio**: validate bus definitions and synthetic WAV options ([#132](https://github.com/Duylamneuuu/Kinetra/pull/132))
- **verification**: reject malformed perceptual hashes/thresholds, exact dHash block sums, seeded property tests ([#134](https://github.com/Duylamneuuu/Kinetra/pull/134))
- **physics**: keep explicit step timestep local, reject non-finite timesteps and vectors ([#135](https://github.com/Duylamneuuu/Kinetra/pull/135))
- **renderer-three**: reject blend spaces whose samples resolve to the same clip ([#120](https://github.com/Duylamneuuu/Kinetra/pull/120))
- **animation**: exact looping root motion for reverse playback and negative playback time ([#128](https://github.com/Duylamneuuu/Kinetra/pull/128))
- **input**: ignore non-finite input values, validate remap bindings, keep shell booting on stale settings; add property tests ([#131](https://github.com/Duylamneuuu/Kinetra/pull/131))
- **reference-game**: keep Arena script state restorable under hostile payloads; add seeded save-contract fuzz test ([#130](https://github.com/Duylamneuuu/Kinetra/pull/130))
- **project-model**: structured validation for untrusted documents and locale-independent ordering ([#129](https://github.com/Duylamneuuu/Kinetra/pull/129))
- **navigation**: report unreachable goals as partial paths and validate bake input ([#126](https://github.com/Duylamneuuu/Kinetra/pull/126))
- **animation**: reject NaN graph parameters, prototype-key lookups and invalid graph data; locale-independent transition order ([#111](https://github.com/Duylamneuuu/Kinetra/pull/111))
- **save-state**: validate save schemaVersion, reject Windows reserved keys, sanitize custom bindings; add property tests ([#124](https://github.com/Duylamneuuu/Kinetra/pull/124))
- **renderer-three**: keep IK idempotent on un-animated bones, apply to clip-less models, deterministic chain order ([#77](https://github.com/Duylamneuuu/Kinetra/pull/77))
- **core,audio**: serialize scene lifecycle transitions, reject prefab cycles/id collisions, locale-free script order, validate audio inputs ([#119](https://github.com/Duylamneuuu/Kinetra/pull/119))
- **command-bus**: structured parent-cycle errors, LIFO undo, reserved component names; add model-based property tests ([#121](https://github.com/Duylamneuuu/Kinetra/pull/121))
- **assets**: enforce full EXT_meshopt_compression validity rules and count stored geometry/image bytes exactly ([#117](https://github.com/Duylamneuuu/Kinetra/pull/117))

### Tests

- **verification**: unit-test KinetraRuntimeProbe fallbacks and runProcessSmoke ([#147](https://github.com/Duylamneuuu/Kinetra/pull/147))
- **repo**: add dependency-free unit-test coverage report (`pnpm coverage`) ([#139](https://github.com/Duylamneuuu/Kinetra/pull/139))
- **animation**: seeded property tests for blend space, IK and morph-target contracts ([#115](https://github.com/Duylamneuuu/Kinetra/pull/115))

### Documentation

- **docs**: executable doc examples (`pnpm check:docs`), animation + MCP agent guides, CHANGELOG, HANDOFF through #75 ([#116](https://github.com/Duylamneuuu/Kinetra/pull/116))

### Maintenance

- **deps**: bump electron 38.8.6 -> 41.10.7, clearing every remaining Electron advisory in `pnpm audit` ([#161](https://github.com/Duylamneuuu/Kinetra/pull/161))
- **player**: lazy-load Rapier and Recast, add initial-chunk bundle budget (perf) ([#148](https://github.com/Duylamneuuu/Kinetra/pull/148))
- **ci**: add player bundle-size budget gate with tested evaluator ([#114](https://github.com/Duylamneuuu/Kinetra/pull/114))
- **deps**: bump transitive source-map-js to 1.2.2 (DoS advisory) ([#113](https://github.com/Duylamneuuu/Kinetra/pull/113))
- **deps**: bump electron 38.0.0 -> 38.8.6 (security patches) and derive packager version from installed electron ([#112](https://github.com/Duylamneuuu/Kinetra/pull/112))
- **ci**: add pnpm lint (oxlint, errors-only gate) and run it in pnpm check ([#127](https://github.com/Duylamneuuu/Kinetra/pull/127))
- **ci**: fail on unregistered test files; run the missing real-ik-bridge test ([#118](https://github.com/Duylamneuuu/Kinetra/pull/118))
- **ci**: cache pnpm store, enforce frozen lockfile, cancel superseded PR runs ([#76](https://github.com/Duylamneuuu/Kinetra/pull/76))

## 2026-09-28

### Added

- **verification**: enforce packaged runtime performance budgets ([#67](https://github.com/Duylamneuuu/Kinetra/pull/67))
- **verification**: add perceptual visual evidence and vision critique hook ([#66](https://github.com/Duylamneuuu/Kinetra/pull/66))
- **assets**: close Blender hot-reimport production gate ([#65](https://github.com/Duylamneuuu/Kinetra/pull/65))
- **assets**: hot reimport and reload live asset dependencies ([#64](https://github.com/Duylamneuuu/Kinetra/pull/64))

## 2026-09-27

### Added

- **animation**: prove safe multi-instance skinned model lifecycle ([#63](https://github.com/Duylamneuuu/Kinetra/pull/63))
- **animation**: drive Rapier character motion from extracted root motion ([#62](https://github.com/Duylamneuuu/Kinetra/pull/62))
- **animation**: runtime animation graph and deterministic crossfade ([#61](https://github.com/Duylamneuuu/Kinetra/pull/61))

## 2026-09-26

### Added

- **animation**: cache baked humanoid retarget clips ([#60](https://github.com/Duylamneuuu/Kinetra/pull/60))
- **animation**: real external humanoid retargeting vertical slice ([#59](https://github.com/Duylamneuuu/Kinetra/pull/59))
- **animation**: drive real rigged character animation from combat state ([#56](https://github.com/Duylamneuuu/Kinetra/pull/56))
- **assets**: prove Scenario-to-Kinetra AI asset pipeline ([#55](https://github.com/Duylamneuuu/Kinetra/pull/55))
- **p10**: combat feel, enemy telegraphing, and encounter progression ([#54](https://github.com/Duylamneuuu/Kinetra/pull/54))

### Fixed

- **assets**: correct energy-crate synthetic provenance and enforce repo-wide audit ([#58](https://github.com/Duylamneuuu/Kinetra/pull/58))
- **assets**: correct enemy-bot synthetic fixture provenance and reject external claims ([#57](https://github.com/Duylamneuuu/Kinetra/pull/57))

### Tests

- **arena**: add canonical loadable Arena project snapshot ([#53](https://github.com/Duylamneuuu/Kinetra/pull/53))

## 2026-09-23

### Added

- **linux**: add packaged KinetraGame x64 runtime
- **mcp**: add structured command error remediation
- **linux**: add real Electron runtime smoke

### Fixed

- **verification**: add truthful missing-path diagnostics

### Tests

- **linux**: run real Electron verification under xvfb

## 2026-09-21

### Added

- **p10**: combat foundation with player attack, damage model, and enemy defeat state ([#46](https://github.com/Duylamneuuu/Kinetra/pull/46))
- **p10**: gameplay loop expansion with objectives, challenge, and HUD projection ([#45](https://github.com/Duylamneuuu/Kinetra/pull/45))
- **p10**: game shell, HUD, pause, settings, and controller support
- **p10**: Kinetra Arena playable reference-game core

## 2026-09-20

### Added

- **p8**: MCP and packaged acceptance execution
- **save-state**: real file-backed desktop persistence
- **audio**: real runtime audio integration
- **gameplay**: real transactional save/load persistence
- **gameplay**: real gameplay script lifecycle and semantic input

## 2026-09-19

### Added

- **animation**: real GLB animation playback in Electron runtime
- **assets**: load and render GLB models in real runtime via assetId
- **navigation**: complete real runtime Recast navigation proof
- **navigation**: Recast navigation integration package (P7 Slice 2) ([#34](https://github.com/Duylamneuuu/Kinetra/pull/34))
- integrate Rapier physics and prove in real Electron runtime ([#33](https://github.com/Duylamneuuu/Kinetra/pull/33))
- connect verification runner to real Electron runtime probe
- complete real Electron runtime bridge ([#31](https://github.com/Duylamneuuu/Kinetra/pull/31))
- add complete-game runtime contracts
- add semantic acceptance verification core
- add deterministic Blender asset pipeline core
- add AI-readable animation core
- add P2 MCP authoring vertical slice
- prove Windows packaged player path
- harden P0 command boundary and license policy
- implement P0 runtime contracts

### Documentation

- add agent handoff and implementation status

### Maintenance

- bootstrap Kinetra AI-first engine foundation
- initialize repository
