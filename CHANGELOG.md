# Changelog

All notable changes merged to `main`, newest first. Kinetra has no tagged releases yet, so entries are grouped by commit date.
Entries are derived from squash-merge commit titles; the PR number links to the full description and verification evidence.
What is actually *proven* (and at which level) is tracked in [`docs/STATUS.md`](docs/STATUS.md), not here.

Maintenance: when a PR merges, add one line under its commit date in the matching section, using the PR title (`ci`/`build`/`chore` go under Maintenance).

## 2026-10-09

### Added

- **player**: expose IK chains/targets through the runtime bridge ([#75](https://github.com/Duylamneuuu/Kinetra/pull/75))
- **renderer-three**: apply IK solver to skeleton bones after mixer update ([#74](https://github.com/Duylamneuuu/Kinetra/pull/74))
- **assets**: add GLB compression policy and Meshopt decoding in the runtime loader ([#73](https://github.com/Duylamneuuu/Kinetra/pull/73))
- **animation**: add pure two-bone and FABRIK IK solver contract ([#71](https://github.com/Duylamneuuu/Kinetra/pull/71))
- **animation**: drive glTF morph targets by name in the runtime ([#72](https://github.com/Duylamneuuu/Kinetra/pull/72))
- **animation**: play 1D/2D locomotion blend spaces in the runtime with phase sync ([#70](https://github.com/Duylamneuuu/Kinetra/pull/70))
- **animation**: add pure 1D/2D locomotion blend-space contract ([#69](https://github.com/Duylamneuuu/Kinetra/pull/69))

### Tests

- **animation**: seeded property tests for blend space, IK and morph-target contracts ([#115](https://github.com/Duylamneuuu/Kinetra/pull/115))

### Maintenance

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
