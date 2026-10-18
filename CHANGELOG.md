# Changelog

All notable changes merged to `main`, newest first. Kinetra has no tagged releases yet, so entries are grouped by commit date.
Entries are derived from squash-merge commit titles; the PR number links to the full description and verification evidence.
What is actually *proven* (and at which level) is tracked in [`docs/STATUS.md`](docs/STATUS.md), not here.

Maintenance: when a PR merges, add one line under its commit date in the matching section, using the PR title (`ci`/`build`/`chore` go under Maintenance).

## 2026-10-18

### Fixed

- **player**: log-buffer không đánh dấu [circular] cho tham chiếu dùng chung (Fixes #568) ([#590](https://github.com/Duylamneuuu/Kinetra/pull/590))
- **save-state**: set() xoá file legacy chữ hoa (Refs #558) ([#591](https://github.com/Duylamneuuu/Kinetra/pull/591))

## 2026-10-17

### Fixed

- **player**: ép thứ tự kiểm sceneId trước khi dừng game + test (Fixes #479) ([#587](https://github.com/Duylamneuuu/Kinetra/pull/587))

### Documentation

- **status**: đóng ô bảng hàng P7 bị thiếu dấu `|` cuối (#528) ([#584](https://github.com/Duylamneuuu/Kinetra/pull/584))

## 2026-10-16

### Fixed

- **renderer-three**: dispose template của reload bị thay thế, báo skippedEntities (Refs #579) ([#585](https://github.com/Duylamneuuu/Kinetra/pull/585))

## 2026-10-15

### Added

- **orb-run**: level pack — classic, pillars, swamp, causeway authored on the command bus (slice 47) ([#582](https://github.com/Duylamneuuu/Kinetra/pull/582))

### Fixed

- **renderer-three**: a stale reload finishing late no longer overwrites a newer reload (#577) ([#578](https://github.com/Duylamneuuu/Kinetra/pull/578))
- **renderer-three**: overlapping `reloadAsset` calls on the same asset are all applied (#564) ([#576](https://github.com/Duylamneuuu/Kinetra/pull/576))
- **player**: the shell no longer sticks when Continue/Main menu fails, and listeners no longer cause unhandled rejections ([#573](https://github.com/Duylamneuuu/Kinetra/pull/573))
- **animation**: root motion rejects glTF CUBICSPLINE tracks instead of reading tangents as positions (#522) ([#572](https://github.com/Duylamneuuu/Kinetra/pull/572))
- **asset-pipeline**: `stop()` cancels queued changes; no transaction runs after the coordinator stopped ([#569](https://github.com/Duylamneuuu/Kinetra/pull/569))

### Tests

- **player**: supersession guard for `loadSave` + stop()/start() race tests (#544) ([#581](https://github.com/Duylamneuuu/Kinetra/pull/581))
- **editor**: inspector RigidBody type defaults to fixed, mass applies only to dynamic (#529 item 3) ([#566](https://github.com/Duylamneuuu/Kinetra/pull/566))
- **orb-run**: README held to the tree (slice 46) ([#575](https://github.com/Duylamneuuu/Kinetra/pull/575))

## 2026-10-14

### Added

- forward dropped root-motion/IK/morph maps from asset reload to coordinator, bridge and logs (#310) ([#421](https://github.com/Duylamneuuu/Kinetra/pull/421))
- **project-model**: schemas for the `Collider`, `RigidBody`, `CharacterBody` and `NavMesh` components (Refs #462) ([#519](https://github.com/Duylamneuuu/Kinetra/pull/519))

### Fixed

- **player**: bounded runtime log buffer; `#log` no longer throws on non-cloneable data ([#565](https://github.com/Duylamneuuu/Kinetra/pull/565))
- **renderer-three**: `reloadAsset` claims the entity's load token; a slow `loadModels` no longer overwrites a reloaded instance ([#561](https://github.com/Duylamneuuu/Kinetra/pull/561))
- **save-state**: tên file slot luôn chữ thường, Slot1/slot1 là một save (#524) ([#557](https://github.com/Duylamneuuu/Kinetra/pull/557))
- **verification**: ElectronRuntimeHost tắt bridge kẹt khi quá hạn ready, request sau khởi động bridge mới ([#555](https://github.com/Duylamneuuu/Kinetra/pull/555))
- **physics-rapier**: Transform.rotation là hướng ban đầu của body dựng từ scene (Fixes #466) ([#550](https://github.com/Duylamneuuu/Kinetra/pull/550))
- **renderer-three**: ModelTemplateCache fails with coded errors for unresolved/unsupported/bad base64/loadAsync (#548) ([#549](https://github.com/Duylamneuuu/Kinetra/pull/549))
- **save-state**: the settings `fullscreen` flag accepts only boolean `true` ([#543](https://github.com/Duylamneuuu/Kinetra/pull/543))
- **project-model**: `Collider.size` / `halfExtents` / `halfHeight` must be `> 0`, as `physics-rapier` already demanded ([#540](https://github.com/Duylamneuuu/Kinetra/pull/540))
- **player**: `loadSave` no longer touches `#runtime` / `#scripts` after an `await` when `stop()` / `start()` interleaves; it returns a structured preparation failure instead (Fixes #537) ([#539](https://github.com/Duylamneuuu/Kinetra/pull/539))
- **core**: `PlayerControllerScript` restore clears `lastAction` when the save has no such key (`getState` omits the key when it is unset) ([#534](https://github.com/Duylamneuuu/Kinetra/pull/534))
- **project-model**: a `RigidBody` without `type` is `fixed`, as in the physics factory, and no longer demands `mass > 0` ([#527](https://github.com/Duylamneuuu/Kinetra/pull/527))

### Tests

- **physics-rapier**: schema vs `resolveColliderPlan` RigidBody parity (#529 item 2) ([#562](https://github.com/Duylamneuuu/Kinetra/pull/562))
- **orb-run**: slice 45 — planner slack held to the real bot on walled and muddy levels ([#560](https://github.com/Duylamneuuu/Kinetra/pull/560))
- **renderer-three**: root motion invalidRoot diagnostics, refused-request isolation and default Hips root ([#556](https://github.com/Duylamneuuu/Kinetra/pull/556))
- **orb-run**: slice 44 — browser sandbox guards and audio refusals in the browser-shaped host ([#554](https://github.com/Duylamneuuu/Kinetra/pull/554))
- **renderer-three**: scene construction errors, component defaults and disposed loadModels ([#553](https://github.com/Duylamneuuu/Kinetra/pull/553))
- **orb-run**: slice 43 - HUD, save/quick-load, audio and animator run in the browser-shaped host (byte-identical to the Node build) ([#552](https://github.com/Duylamneuuu/Kinetra/pull/552))
- **player**: saved entities and `assets.byId` keep an id named `__proto__` (pure builder + test, Refs #252) ([#547](https://github.com/Duylamneuuu/Kinetra/pull/547))
- **orb-run**: slice 42 the play path runs in a browser-shaped host (replay yields without `setImmediate`) ([#546](https://github.com/Duylamneuuu/Kinetra/pull/546))
- **renderer-three**: `ModelTemplateCache` source branches (Uint8Array view, ArrayBuffer, data/URL, invalid) ([#545](https://github.com/Duylamneuuu/Kinetra/pull/545))
- **orb-run**: slice 41 a real esbuild bundle of the entry plays the same game (`test/real-bundle.test.ts`) ([#542](https://github.com/Duylamneuuu/Kinetra/pull/542))
- **renderer-three**: `WebGL2Backend` lifecycle (initialize / render / getStats / dispose) ([#541](https://github.com/Duylamneuuu/Kinetra/pull/541))
- **orb-run**: slice 40 the audio mix is a player preference, not game state ([#538](https://github.com/Duylamneuuu/Kinetra/pull/538))
- **orb-run**: slice 39 what a running game sees of authoring done after it started (`test/late-authoring.test.ts`, #437 item 3) ([#535](https://github.com/Duylamneuuu/Kinetra/pull/535))
- **verification**: zero-width PNG frames through evidence and comparison ([#532](https://github.com/Duylamneuuu/Kinetra/pull/532))
- **orb-run**: slice 38 the sign of the level check's slack matches the bot ([#531](https://github.com/Duylamneuuu/Kinetra/pull/531))
- **orb-run**: slice 37 random walled and muddy levels: level check = route plan = real game ([#525](https://github.com/Duylamneuuu/Kinetra/pull/525))

### Documentation

- CHANGELOG and STATUS snapshot through PR #560 ([#563](https://github.com/Duylamneuuu/Kinetra/pull/563))
- CHANGELOG + STATUS snapshot for PRs merged after #547 ([#559](https://github.com/Duylamneuuu/Kinetra/pull/559))
- CHANGELOG and STATUS snapshot through PR #547 ([#551](https://github.com/Duylamneuuu/Kinetra/pull/551))
- CHANGELOG and STATUS snapshot through PR #547 (replaces the stale snapshot PRs #516, #523, #533, #536)
- CHANGELOG and STATUS snapshot through PR #515 ([#518](https://github.com/Duylamneuuu/Kinetra/pull/518))

### Maintenance

- **physics-rapier**: one shared `resolveColliderPlan` for `populateWorld` and the diagnostics (Refs #383) ([#526](https://github.com/Duylamneuuu/Kinetra/pull/526))

## 2026-10-13

### Added

- **mcp-server**: new tools `entity.removeComponent` and `entity.unsetFields` over the command-bus `component.remove` / `component.unsetFields` commands (#461) ([#502](https://github.com/Duylamneuuu/Kinetra/pull/502))
- **orb-run**: slice 31 `advance`/`advanceUntil` refuse non-integer step counts ([#495](https://github.com/Duylamneuuu/Kinetra/pull/495))
- **orb-run**: slice 29 quick-load drops the abandoned timeline's history (`HeadlessSceneSimulation.discardHistoryAfter`, `HeadlessAudioService.rewindTo`); rollback failures are reported ([#486](https://github.com/Duylamneuuu/Kinetra/pull/486))
- **orb-run**: slice 28 review follow-ups on save validation ([#478](https://github.com/Duylamneuuu/Kinetra/pull/478))
- **orb-run**: slice 27 a save from another level or a hand-edited counter is refused ([#476](https://github.com/Duylamneuuu/Kinetra/pull/476))
- **orb-run**: slice 26 quick-load moves the simulation clock with the restored state ([#471](https://github.com/Duylamneuuu/Kinetra/pull/471))
- **orb-run**: slice 25 saves are untrusted input: validated, all-or-nothing restore ([#468](https://github.com/Duylamneuuu/Kinetra/pull/468))
- **command-bus**: new commands `component.remove` and `component.unsetFields` with structured `COMPONENT_NOT_FOUND` / `FIELD_NOT_FOUND` errors (Refs #321) ([#455](https://github.com/Duylamneuuu/Kinetra/pull/455))
- **orb-run**: slice 23 the fuzzer holds the player to its speed limit, mud included (`player_speed_bound` invariant) ([#449](https://github.com/Duylamneuuu/Kinetra/pull/449))
- **orb-run**: slice 22 the route planner prices mud (`OrbRunSlowZone` areas cost more on the navmesh route); #446 follows up the review notes ([#444](https://github.com/Duylamneuuu/Kinetra/pull/444), [#443](https://github.com/Duylamneuuu/Kinetra/pull/443))
- **animation**: new warning `anim.graph.transition.sharedClipCut` and blend-space input diagnostics for animation graphs (Refs #159) ([#445](https://github.com/Duylamneuuu/Kinetra/pull/445))
- **orb-run**: slice 21 mud (`OrbRunSlowZone`) authored as data ([#436](https://github.com/Duylamneuuu/Kinetra/pull/436))
- **orb-run**: slice 20 the entry stays portable: `entry-portability` test guards the source import graph (no Node builtins/globals/Node-only modules), `Buffer` replaced by a strict portable base64 helper ([#416](https://github.com/Duylamneuuu/Kinetra/pull/416))

### Fixed

- **player**: the frame loop keeps scheduling `requestAnimationFrame` when a tick throws ([#520](https://github.com/Duylamneuuu/Kinetra/pull/520))
- **save-state**: the file storage refuses a `settings_` key alias whatever its letter case (`saves:Settings_user` is the same file on NTFS and macOS) ([#511](https://github.com/Duylamneuuu/Kinetra/pull/511))
- **orb-run**: slice 34 stepping out of wall A can no longer end inside wall B (`axisMoveAllowed` judges every wall) ([#509](https://github.com/Duylamneuuu/Kinetra/pull/509))
- **orb-run**: slice 33 a player pressed into a wall can walk out but not deeper (`resolveWallMotion`) ([#508](https://github.com/Duylamneuuu/Kinetra/pull/508))
- **player**: the Electron player logs the physics collider fallback diagnostics (`physics.unsupportedColliderShape`) to its runtime log (Refs #383, #354) ([#506](https://github.com/Duylamneuuu/Kinetra/pull/506))
- **animation**: `stripVisualRootDisplacement` keeps the interpolation (STEP) of the root track ([#504](https://github.com/Duylamneuuu/Kinetra/pull/504))
- **player**: `loadSave` returns `phase` and `slotId` on every failure branch ([#501](https://github.com/Duylamneuuu/Kinetra/pull/501))
- **orb-run**: `OrbRunReplayRecorder` handles quick-load / `restoreStep` while recording ([#497](https://github.com/Duylamneuuu/Kinetra/pull/497))
- **asset-pipeline**: the coordinator republishes assets the runtime rejected (Refs #252 item 3) ([#496](https://github.com/Duylamneuuu/Kinetra/pull/496))
- **asset-pipeline**: `createSyntheticGlb` normalizes rotation quaternions and rejects a zero-length quaternion (#481) ([#491](https://github.com/Duylamneuuu/Kinetra/pull/491))
- **orb-run**: `HeadlessAudioService.rewindTo` undoes the `stop()` of an abandoned timeline's audio (bug introduced by #486) ([#490](https://github.com/Duylamneuuu/Kinetra/pull/490))
- **animation**: `computeRetargetCacheKey` tells `NaN`/`Infinity` apart from `null` and keeps a `__proto__` key (shared `canonicalizeForCacheKey`) ([#484](https://github.com/Duylamneuuu/Kinetra/pull/484))
- **animation**: `bakeRetargetedClip` keeps the step/smooth interpolation of the source track and drops a track whose value count does not match its key count ([#483](https://github.com/Duylamneuuu/Kinetra/pull/483))
- **player**: an error with a code from the renderer reaches the bridge as `<code>: <message>` plus `code` (Refs #354) ([#433](https://github.com/Duylamneuuu/Kinetra/pull/433))
- **asset-pipeline**: `createSyntheticGlb` rotation channels write quaternion (VEC4) output and validate `from`/`to` ([#477](https://github.com/Duylamneuuu/Kinetra/pull/477))
- **player**: `bakeNavigation` geometry wins over `positions`/`indices` keys in the config ([#475](https://github.com/Duylamneuuu/Kinetra/pull/475))
- **verification**: `metricMax`/`metricMin` and `detectBlankFrame` no longer pass with a `NaN` threshold or metric ([#473](https://github.com/Duylamneuuu/Kinetra/pull/473))
- **player**: `start()` checks `sceneId` before it stops the running game and overwrites assets (`resolveStartScene`) ([#472](https://github.com/Duylamneuuu/Kinetra/pull/472))
- **verification**: `compareVisualFrames` compares against the threshold with the unrounded value ([#469](https://github.com/Duylamneuuu/Kinetra/pull/469))
- **verification**: `KinetraRuntimeProbe` throws when the host lacks an action method instead of passing falsely (Refs #460) ([#467](https://github.com/Duylamneuuu/Kinetra/pull/467))
- **player**: a fatal load failure keeps exit code 1 (first exit code wins) and `loadFile` has a `.catch` (follow-up of #453) ([#456](https://github.com/Duylamneuuu/Kinetra/pull/456))
- **player**: physics sync no longer wipes the root-motion yaw of a kinematic character ([#465](https://github.com/Duylamneuuu/Kinetra/pull/465))
- **command-bus**: `component.unsetFields` keeps a `__proto__` field as plain data instead of re-prototyping the object or losing the field ([#464](https://github.com/Duylamneuuu/Kinetra/pull/464))
- **player, verification**: non-finite frame-time samples give a `NaN` percentile and an explicit budget-violation reason instead of passing silently (Refs #187) ([#459](https://github.com/Duylamneuuu/Kinetra/pull/459))
- **verification**: `assert.near` / `metricMax` / `metricMin` no longer pass with `NaN`; `assert.equal` ignores key order and no longer treats `NaN` as `null` ([#458](https://github.com/Duylamneuuu/Kinetra/pull/458))
- **player**: `did-fail-load` is fatal only for the main frame and not for `ERR_ABORTED`; the fatal message is flushed before `app.exit` ([#453](https://github.com/Duylamneuuu/Kinetra/pull/453))
- **player**: `loadSave` returns a structured failure for malformed entity entries and for a throwing `prepareRestoreState` instead of a raw `TypeError` ([#450](https://github.com/Duylamneuuu/Kinetra/pull/450))
- **animation**: `extractRootMotionFromClip` rejects a corrupt rotation track (Refs #437) ([#447](https://github.com/Duylamneuuu/Kinetra/pull/447))
- **orb-run**: slice 22b review follow-ups of the mud pricing ([#446](https://github.com/Duylamneuuu/Kinetra/pull/446))
- **asset-pipeline**: `hashJson` rejects `Map`/`Set`/`RegExp`/`Promise`/`Error` instead of hashing them as `{}` ([#424](https://github.com/Duylamneuuu/Kinetra/pull/424))
- **asset-pipeline**: `normalizeGlb` reports optional glTF extensions it drops (`droppedExtensions`) and no longer logs to the console ([#418](https://github.com/Duylamneuuu/Kinetra/pull/418))
- **renderer-three**: `WebGL2Backend.resize` rejects non-finite/negative sizes and falls back to dpr 1 for `NaN`/`Infinity` ([#442](https://github.com/Duylamneuuu/Kinetra/pull/442))
- **verification**: `ElectronRuntimeHost.close()` during startup fails the waiting request at once and lets later requests launch a fresh bridge ([#438](https://github.com/Duylamneuuu/Kinetra/pull/438))
- **animation**: `extractRootMotionFromClip` rejects `NaN`/`Infinity` keyframe values and short position tracks ([#435](https://github.com/Duylamneuuu/Kinetra/pull/435))
- **player**: `PlayerAudioController.reset()` drops the dead scene's asset resolver, so `play()` after stop fails as not initialized instead of bypassing bus volumes ([#430](https://github.com/Duylamneuuu/Kinetra/pull/430))
- **orb-run**: the `entry-portability` test runs on Windows (fixes the red "Windows player package" job) ([#432](https://github.com/Duylamneuuu/Kinetra/pull/432))
- **orb-run**: `navmesh_error` replaces `route_blocked` for navmesh failures; WAV extensible/empty/bit-depth handling; warning for a wrongly declared size (#411 #413 #415) ([#429](https://github.com/Duylamneuuu/Kinetra/pull/429))
- **player**: `isEqualJson` treats `NaN` as equal to itself and no longer equates an array with an object of the same keys (so a clean rollback is no longer reported as an atomicity violation); the runtime-controller pure helpers (base64, `isEqualJson`, percentiles) are extracted into `runtime-helpers.ts` and unit-tested ([#417](https://github.com/Duylamneuuu/Kinetra/pull/417))
- **orb-run**: the importer measures and reads real asset metadata instead of copying declared numbers (Refs #231 items 3–5) ([#407](https://github.com/Duylamneuuu/Kinetra/pull/407))
- **orb-run**: `planOrbRunRoute` reports a stop walled in tighter than the route agent as `route_blocked` instead of throwing ([#406](https://github.com/Duylamneuuu/Kinetra/pull/406))
- **verification**: `ElectronRuntimeHost.close()` no longer clobbers a replacement bridge launched during teardown; a close during pipe bind launches nothing ([#405](https://github.com/Duylamneuuu/Kinetra/pull/405))
- **command-bus**: `parseEngineCommand` reports unreadable input as `INVALID_COMMAND`, not a raw `DOMException` ([#404](https://github.com/Duylamneuuu/Kinetra/pull/404))
- **orb-run**: slice 19 the HUD fails loudly on corrupt state (`OrbRunHudError`, `ORB_RUN_HUD_INVALID`); a run won on the tick the clock hits 0 reads `normal`, not `expired` (#205) ([#402](https://github.com/Duylamneuuu/Kinetra/pull/402))

### Tests

- **orb-run**: slice 36 a wall under the player, proven through the whole game (`test/wall-under-player.test.ts`, 6 tests) ([#521](https://github.com/Duylamneuuu/Kinetra/pull/521))
- **orb-run**: `advanceUntil` boundary pinned: the predicate is true at the last step and `maxSteps=0` (Refs #500) ([#517](https://github.com/Duylamneuuu/Kinetra/pull/517))
- **verification**: tiny, zero-area and mismatched-size frame edges of `visual.ts` covered ([#513](https://github.com/Duylamneuuu/Kinetra/pull/513))
- **orb-run**: slice 35 wall clearance invariants and one distance formula (`signedDistanceToWall`) ([#515](https://github.com/Duylamneuuu/Kinetra/pull/515))
- **asset-pipeline**: the visit-budget boundary of `glb-bounds` is pinned (Refs #383) ([#512](https://github.com/Duylamneuuu/Kinetra/pull/512))
- **verification**: visual-baseline CLI argument, ENOTDIR and extension edges covered ([#510](https://github.com/Duylamneuuu/Kinetra/pull/510))
- **mcp-server**: the `#flushUnsaved` failure path on a refused undo retry is covered ([#505](https://github.com/Duylamneuuu/Kinetra/pull/505))
- **orb-run**: slice 32 mud asserted from an `AcceptanceManifest` (follow-up #437 item 2) ([#503](https://github.com/Duylamneuuu/Kinetra/pull/503))
- **verification**: `AcceptanceRunner` wait/step fallback, path-traversal diagnostics and `logAbsent` filters covered ([#493](https://github.com/Duylamneuuu/Kinetra/pull/493))
- **animation**: `inspectSkeletonFromGlb` fallbacks, parent lookup and durations covered ([#494](https://github.com/Duylamneuuu/Kinetra/pull/494))
- **orb-run**: slice 30 duplicate `orbCollected` events count and cue once; stale README gap removed (#187) ([#489](https://github.com/Duylamneuuu/Kinetra/pull/489))
- **animation**: clip event validation, duplicate bone targets, machine reset and retarget diagnostics ([#487](https://github.com/Duylamneuuu/Kinetra/pull/487))
- **physics-rapier**: validation, `halfExtents` and diagnostics edge tests (branch coverage 93.4% → 97.7%) ([#488](https://github.com/Duylamneuuu/Kinetra/pull/488))
- **animation**: branches of `validateClipMetadata` and `validateSkeletonProfile` (events outside the duration, unsorted, non-finite; duplicate bone target) ([#485](https://github.com/Duylamneuuu/Kinetra/pull/485))
- **verification**: `close()` during startup fails the waiting request at once; dead `#rejectReady` removed ([#426](https://github.com/Duylamneuuu/Kinetra/pull/426))
- **editor**: model-based fuzz of `EditorSession` (failed edits leave the bus untouched, undo/redo restore exact projects, selection never lists missing entities) ([#434](https://github.com/Duylamneuuu/Kinetra/pull/434))
- **orb-run**: slice 24 transitive portability test follows the imports of the entry through the engine package barrels ([#452](https://github.com/Duylamneuuu/Kinetra/pull/452))
- **asset-pipeline / physics-rapier**: glb-bounds sparse accessors, raw integer and truncated-BIN cases, plus pending kinematic body edge cases (Fixes #367) ([#454](https://github.com/Duylamneuuu/Kinetra/pull/454))
- **reference-game**: enemy and player branches with a missing transform, scene, graph or player ([#451](https://github.com/Duylamneuuu/Kinetra/pull/451))
- **animation**: retarget cache storage and record-validation edge cases ([#428](https://github.com/Duylamneuuu/Kinetra/pull/428))
- **animation**: root-motion clip helper edge cases (coverage gap) ([#439](https://github.com/Duylamneuuu/Kinetra/pull/439))
- **mcp-server**: `runtime.*` and `test.runAcceptance` MCP tool forwarding ([#425](https://github.com/Duylamneuuu/Kinetra/pull/425))
- **asset-pipeline**: `SourceAssetWatcher` edge cases (initial hash baseline, `removeAsset`, listener isolation, `stop()` cancels the re-arm) and `hashFile` ([#409](https://github.com/Duylamneuuu/Kinetra/pull/409))
- **core**: `ScriptHost` / `ScriptRegistry` / prefab API edge tests closing a coverage gap ([#410](https://github.com/Duylamneuuu/Kinetra/pull/410))
- **animation**: regression suite for malformed animation graphs (supersedes #261) ([#403](https://github.com/Duylamneuuu/Kinetra/pull/403))

### Documentation

- CHANGELOG and STATUS snapshot through PR #504; the MCP guide lists `COMPONENT_NOT_FOUND` / `FIELD_NOT_FOUND` ([#507](https://github.com/Duylamneuuu/Kinetra/pull/507))
- CHANGELOG and STATUS snapshot through PR #490 ([#492](https://github.com/Duylamneuuu/Kinetra/pull/492))
- CHANGELOG and STATUS snapshot through PR #490 ([#492](https://github.com/Duylamneuuu/Kinetra/pull/492))
- CHANGELOG and STATUS snapshot through PR #497 ([#499](https://github.com/Duylamneuuu/Kinetra/pull/499))
- CHANGELOG/STATUS through #468; the command-bus README documents `component.remove`/`unsetFields` ([#470](https://github.com/Duylamneuuu/Kinetra/pull/470))
- CHANGELOG and STATUS snapshot through PR #458 ([#463](https://github.com/Duylamneuuu/Kinetra/pull/463))
- CHANGELOG and STATUS snapshot through PR #446 ([#448](https://github.com/Duylamneuuu/Kinetra/pull/448))

### Maintenance

- **ci**: coverage retries a failed package once and annotates the failing tests ([#441](https://github.com/Duylamneuuu/Kinetra/pull/441))

## 2026-10-12

### Added

- **orb-run**: slice 18 follow-up navigation probe: `state.navigation` from the navmesh route planner and the navigation acceptance manifest ([#398](https://github.com/Duylamneuuu/Kinetra/pull/398))

## 2026-10-11

### Added

- **orb-run**: slice 18 walls and routes as acceptance state (`state.navigation`) ([#396](https://github.com/Duylamneuuu/Kinetra/pull/396))
- **orb-run**: slice 17 the fuzzer plays on walled levels (`player_clear_of_walls` invariant, walled campaigns, replay and save/resume) ([#388](https://github.com/Duylamneuuu/Kinetra/pull/388))
- **orb-run**: slice 16 walls (`OrbRunWall` component) and a route planned on the engine's navmesh (`@kinetra/navigation-recast`); the level check is wall-aware ([#382](https://github.com/Duylamneuuu/Kinetra/pull/382))
- **orb-run**: slice 15 art hot-reloads through the engine's `AssetHotReloadCoordinator` (headless runtime target, injected faults, gameplay untouched) ([#372](https://github.com/Duylamneuuu/Kinetra/pull/372))
- **editor**: asset browser model (`buildAssetBrowser`/`filterAssetBrowser`) and console model (`EditorConsole`) (refs #274, #104) ([#366](https://github.com/Duylamneuuu/Kinetra/pull/366))
- **orb-run**: slice 14 seeded input fuzzing (`runOrbRunFuzz`) with per-step invariants, replay determinism and save/resume equivalence ([#360](https://github.com/Duylamneuuu/Kinetra/pull/360))
- **editor**: inspector model (`buildInspector`) and `EditorSession.setProperty` (refs #273) ([#358](https://github.com/Duylamneuuu/Kinetra/pull/358))
- **orb-run**: slice 13 static level check (`analyzeOrbRunLevel`) with clock bounds, probe `state.level` and `level.acceptance.json` ([#351](https://github.com/Duylamneuuu/Kinetra/pull/351))
- **orb-run**: slice 12 one-command acceptance gate (`runOrbRunAcceptanceSuite` + acceptance CLI) ([#347](https://github.com/Duylamneuuu/Kinetra/pull/347))
- **orb-run**: replays as acceptance manifests, digest over every entity position, non-blocking replay playback (slice 11) ([#307](https://github.com/Duylamneuuu/Kinetra/pull/307))
- **project-model**: validate built-in component payloads at the authoring boundary (#81) ([#172](https://github.com/Duylamneuuu/Kinetra/pull/172))

### Fixed

- **verification**: `ElectronRuntimeHost` survives EPIPE on a dead bridge and releases its server and temp dir when the bridge exits ([#386](https://github.com/Duylamneuuu/Kinetra/pull/386))
- **player**: main→renderer requests fail fast when the window closes or send throws; bridge socket keeps an error listener ([#395](https://github.com/Duylamneuuu/Kinetra/pull/395))
- **mcp-server**: `formatToolError` reports `projectRevision` and `rolledBack` of a `ProjectPersistError` as fields ([#391](https://github.com/Duylamneuuu/Kinetra/pull/391))
- **verification**: a budget both exceeded and partly unusable reports both (#231) ([#394](https://github.com/Duylamneuuu/Kinetra/pull/394))
- **asset-pipeline**: reimport failures carry the importer's error code; `blender.invalidOption` is pinned through `AssetReimportService` and staging cleanup (#255) ([#389](https://github.com/Duylamneuuu/Kinetra/pull/389))
- **player**: the navigation request started last wins over a slower earlier bake; a failing install releases the replacement ([#387](https://github.com/Duylamneuuu/Kinetra/pull/387))
- **orb-run**: the animator samples ground once inside its `try`; failing step listeners no longer abort `advance()` (#252) ([#385](https://github.com/Duylamneuuu/Kinetra/pull/385))
- **project-model**: `cloneProject` reports a too-deep document as `ProjectValidationError`; `MAX_JSON_DEPTH` bounds pinned by tests (#205) ([#381](https://github.com/Duylamneuuu/Kinetra/pull/381))
- **asset-pipeline**: JSON bounds fallback stops on shared-children node DAGs and cycles; no unmeasured warning for mesh-less GLBs ([#380](https://github.com/Duylamneuuu/Kinetra/pull/380))
- **physics-rapier**: unsupported collider shapes report a structured diagnostic instead of silently becoming a box (#354) ([#379](https://github.com/Duylamneuuu/Kinetra/pull/379))
- **player,verification**: `runtime.step` params parsed by a tested pure helper; the probe schema enforces the player's step bounds ([#378](https://github.com/Duylamneuuu/Kinetra/pull/378))
- **verification**: the visual-baseline CLI rejects options that belong to the other command; dHash limits documented (#255) ([#377](https://github.com/Duylamneuuu/Kinetra/pull/377))
- **mcp-server**: a failed project save throws a structured `ProjectPersistError` carrying the revision to retry with (#187) ([#376](https://github.com/Duylamneuuu/Kinetra/pull/376))
- **animation**: `ClipEventTracker` keeps an integer loop count so long loops no longer drop boundary events (#189) ([#375](https://github.com/Duylamneuuu/Kinetra/pull/375))
- **player**: saved custom bindings keep an action id named `__proto__` (#228) ([#374](https://github.com/Duylamneuuu/Kinetra/pull/374))
- **core**: `ScriptHost.startAll()` starts scripts registered mid-pass and never shares a start pass queued before another pass (#337) ([#373](https://github.com/Duylamneuuu/Kinetra/pull/373))
- **renderer-three**: blend space phase no longer becomes NaN when `speed * delta` overflows to Infinity ([#371](https://github.com/Duylamneuuu/Kinetra/pull/371))
- **orb-run**: the digest cache sees audio cues started between steps (#329) ([#370](https://github.com/Duylamneuuu/Kinetra/pull/370))
- **blender-bridge**: pass `--python-exit-code 1` so a raising export script fails the export instead of exiting 0 ([#369](https://github.com/Duylamneuuu/Kinetra/pull/369))
- **verification**: baseline artifacts drop stale failing PNGs; concurrent baseline saves use their own temp file ([#365](https://github.com/Duylamneuuu/Kinetra/pull/365))
- **asset-pipeline**: reimport reports `asset.dependency.missing` for declared dependencies absent from the database (#288) ([#364](https://github.com/Duylamneuuu/Kinetra/pull/364))
- **animation**: `validateAnimationGraph` reports states/transitions without a string id instead of letting `undefined` satisfy a missing `entryState` or endpoint ([#362](https://github.com/Duylamneuuu/Kinetra/pull/362))
- **core**: `ScriptHost` lifecycle passes run in call order (`stopAll`/`destroyAll` during `startAll` no longer interleave) ([#361](https://github.com/Duylamneuuu/Kinetra/pull/361))
- **player**: a pending renderer request fails immediately when the reply is malformed but carries its id (#286) ([#359](https://github.com/Duylamneuuu/Kinetra/pull/359))
- **save-state**: v1→v2 migration validates `sceneId`, position/rotation and state instead of passing them through (#205) ([#357](https://github.com/Duylamneuuu/Kinetra/pull/357))
- **physics-rapier**: a query between `moveKinematicBody` and `step` no longer swallows the platform's velocity (moves are re-armed on the real step) ([#356](https://github.com/Duylamneuuu/Kinetra/pull/356))
- **asset-pipeline**: GLBs requiring Draco/meshopt/quantization keep their dimensions (JSON accessor bounds fallback); unmeasurable models report `asset.dimensions.unmeasured` (#329) ([#355](https://github.com/Duylamneuuu/Kinetra/pull/355))
- **player**: preload replies with a structured failure (`BRIDGE_UNCLONEABLE_RESPONSE`) when a result cannot be cloned; `performance.sample` validates frame counts and delta (`resolvePerformanceSampleOptions`) ([#352](https://github.com/Duylamneuuu/Kinetra/pull/352))
- **asset-pipeline**: `AssetHotReloadCoordinator` transaction history is bounded (`maxTransactionHistory`, default 100) ([#349](https://github.com/Duylamneuuu/Kinetra/pull/349))
- **player**: nav bake/load keep the installed mesh when the replacement fails or is cancelled; volume setters reject NaN ([#348](https://github.com/Duylamneuuu/Kinetra/pull/348))
- **physics-rapier**: fixed Collider/Primitive sphere and capsule keep their shape (`addFixedSphere`/`addFixedCapsule`) ([#346](https://github.com/Duylamneuuu/Kinetra/pull/346))
- **animation,core**: clip metadata validates `rootMotionMode`/event names; aim rotations survive non-finite joints; prefab rejects empty `parentLocalId` ([#345](https://github.com/Duylamneuuu/Kinetra/pull/345))
- **project-model**: entity `components` must be a plain object ([#338](https://github.com/Duylamneuuu/Kinetra/pull/338))
- **orb-run**: probe resets the asset catalog per run, bounded failure log, README slice labels (#262) ([#334](https://github.com/Duylamneuuu/Kinetra/pull/334))
- **renderer-three**: reloading into an asset without clips drops the stale animation metadata ([#335](https://github.com/Duylamneuuu/Kinetra/pull/335))
- **animation**: root yaw sampled at the union of position+rotation keys as Y-twist (#313); `ClipEventTracker` constructor is safe and warns on `beyondDuration` (#189) ([#333](https://github.com/Duylamneuuu/Kinetra/pull/333))
- **blender-bridge**: `BlenderGlbImporter` reports measured bounding-box dimensions instead of stamping `[1, 1, 1]` ([#332](https://github.com/Duylamneuuu/Kinetra/pull/332))
- **physics-rapier**: kinematic bodies with a box/sphere `Collider` keep their shape (`addKinematicBody`/`moveKinematicBody`) instead of becoming a capsule (#311) ([#330](https://github.com/Duylamneuuu/Kinetra/pull/330))
- **command-bus**: `entity.reparent` rejects an empty `parentId` instead of silently detaching (detach = omit `parentId`) ([#327](https://github.com/Duylamneuuu/Kinetra/pull/327))
- **core**: overlapping `ScriptHost.startAll`/`stopAll`/`destroyAll` share one pass instead of re-running script hooks ([#326](https://github.com/Duylamneuuu/Kinetra/pull/326))
- **editor,command-bus**: `CommandBus.maxUndoDepth` getter; `EditorSession.maxHistory` defaults to the bus's depth so `canUndo` never claims forgotten edits (#312) ([#325](https://github.com/Duylamneuuu/Kinetra/pull/325))
- **command-bus**: a transaction that would produce an invalid project is a structured `INVALID_COMMAND` (with issues), not a raw `ProjectValidationError` ([#324](https://github.com/Duylamneuuu/Kinetra/pull/324))
- **asset-pipeline,audio,player**: `GlbDirectImporter` measures real dimensions and passthrough copies any bytes; audio gain ceiling `MAX_AUDIO_GAIN=4` (#216, #298) ([#323](https://github.com/Duylamneuuu/Kinetra/pull/323))
- **input**: overflowing binding sums and infinite semantic values saturate at ±1 instead of reading as 0 ([#322](https://github.com/Duylamneuuu/Kinetra/pull/322))
- **verification**: `runProcessSmoke` decodes multi-byte output across chunks, waits for stdio to drain, releases pipes; +8 tests ([#320](https://github.com/Duylamneuuu/Kinetra/pull/320))
- **player**: release input is never rejected for its value; non-finite input raises a structured `PlayerInputError` ([#319](https://github.com/Duylamneuuu/Kinetra/pull/319))
- **orb-run**: drop `node:crypto` from the package entry (pure-JS SHA-256) and cache the state digest per revision (#309) ([#317](https://github.com/Duylamneuuu/Kinetra/pull/317))
- **mcp-server**: a failed save after `undo()` stays pending and is flushed by the next call, so memory and disk converge (#281) ([#315](https://github.com/Duylamneuuu/Kinetra/pull/315))
- **player**: realtime `frame()` applies root motion, release survives pause, non-finite input rejected, controller listeners removable ([#314](https://github.com/Duylamneuuu/Kinetra/pull/314))
- **animation**: root-motion step/sample return a zero delta / first sample for non-finite time, deltaTime, speed or loopDuration instead of NaN ([#304](https://github.com/Duylamneuuu/Kinetra/pull/304))
- **command-bus**: queryEntities selectComponents returns a '__proto__' component as data instead of re-prototyping the result ([#301](https://github.com/Duylamneuuu/Kinetra/pull/301))

### Tests

- **verification**: performance budget edges (percentile properties, thresholds, platform overrides, report writer) ([#397](https://github.com/Duylamneuuu/Kinetra/pull/397))
- **player**: pin runtime.step bounds parity between player and probe schema (#383) ([#393](https://github.com/Duylamneuuu/Kinetra/pull/393))
- **mcp-server**: MCP tools forward every optional field (`dryRun`, `expectedProjectRevision`, `cascade`, `parentId`, query filters) through the real server ([#390](https://github.com/Duylamneuuu/Kinetra/pull/390))
- **reference-game**: `damageDealt` through the real ScriptHost ([#339](https://github.com/Duylamneuuu/Kinetra/pull/339))
- **save-state**: storage contracts property/IPC tests ([#344](https://github.com/Duylamneuuu/Kinetra/pull/344))
- **editor**: `EditorSession` edge cases + undo/redo property test ([#342](https://github.com/Duylamneuuu/Kinetra/pull/342))
- **player**: script-transform service extracted and tested; `translate` validates before the object lookup (#294) ([#336](https://github.com/Duylamneuuu/Kinetra/pull/336))
- **mcp-server**: `LocalRuntimeHost` and `formatToolError` edge cases (+12 tests) ([#331](https://github.com/Duylamneuuu/Kinetra/pull/331))
- **physics-rapier**: moveCharacter sees remove()d walls immediately and never integrates dynamic bodies (#286) ([#305](https://github.com/Duylamneuuu/Kinetra/pull/305))
- **navigation-recast**: unit-test toCells ceil/floor snapping + property test; tiny agentHeight still bakes (#288) ([#308](https://github.com/Duylamneuuu/Kinetra/pull/308))

### Documentation

- **docs**: add PRs #353-#365 to CHANGELOG, STATUS snapshot and HANDOFF range ([#368](https://github.com/Duylamneuuu/Kinetra/pull/368))
- **docs**: record Orb Run slice 14 (seeded input fuzzing) in STATUS ([#363](https://github.com/Duylamneuuu/Kinetra/pull/363))
- **docs**: add PRs #351-#352 to CHANGELOG, HANDOFF hardening batch and STATUS snapshot ([#353](https://github.com/Duylamneuuu/Kinetra/pull/353))

## 2026-10-10

### Added

- **orb-run**: replay/determinism gate (slice 10) ([#290](https://github.com/Duylamneuuu/Kinetra/pull/290))
- **editor**: `@kinetra/editor` headless observer core (#104 part 1): `buildHierarchy` + `EditorSession` that edits only through the command bus, with editor-vs-MCP parity tests ([#258](https://github.com/Duylamneuuu/Kinetra/pull/258))
- **orb-run**: content is part of the acceptance gate (slice 9) ([#250](https://github.com/Duylamneuuu/Kinetra/pull/250))

### Fixed

- **mcp-server**: LocalRuntimeHost.start stops and rebuilds synchronously so overlapping starts cannot leak a runtime ([#299](https://github.com/Duylamneuuu/Kinetra/pull/299))
- **player**: PlayerAudioController.play() reports a throwing resolver / invalid base64 as a failed result; +12 edge tests ([#303](https://github.com/Duylamneuuu/Kinetra/pull/303))
- **physics-rapier,navigation-recast**: scene factory forwards RigidBody.mass and treats kinematicVelocityBased as kinematic; bake rejects sparse positions arrays ([#300](https://github.com/Duylamneuuu/Kinetra/pull/300))
- **editor,asset-pipeline**: EditorSession bounds its undo history; AssetDatabase rejects malformed records ([#302](https://github.com/Duylamneuuu/Kinetra/pull/302))
- **animation**: bakeRetargetedClip rejects an unknown hipsTranslationPolicy and a non-finite/non-positive scaleFactor with a diagnostic ([#297](https://github.com/Duylamneuuu/Kinetra/pull/297))
- **renderer-three**: loadModels no longer stacks a second model on loaded entities, enabling root motion keeps the playing clip's loop mode, reloadAsset keeps root motion enabled ([#295](https://github.com/Duylamneuuu/Kinetra/pull/295))
- **animation**: root-motion yaw is sampled from the rotation track by time, not by key index; inspectClipRootMotion reports a real netYaw ([#292](https://github.com/Duylamneuuu/Kinetra/pull/292))
- **player**: script `transform.setPosition`/`translate` validate finite vectors before mutating the Three.js object ([#287](https://github.com/Duylamneuuu/Kinetra/pull/287))
- **asset-pipeline**: `reimportWithDependents` staleness check fingerprints dependencies like `reimport()` (skips missing ones), no orphan `dependentReimportStarted` ([#285](https://github.com/Duylamneuuu/Kinetra/pull/285))
- **navigation-recast,save-state**: bake rounds agent metres to voxel cells without float drift; `SaveMigrator` rejects a migration that returns undefined ([#284](https://github.com/Duylamneuuu/Kinetra/pull/284))
- **player**: Electron bridge answers an unserialisable result with a structured failure instead of no reply; malformed renderer IPC responses are ignored instead of throwing ([#282](https://github.com/Duylamneuuu/Kinetra/pull/282))
- **physics-rapier**: `moveCharacter` no longer runs a real step and sees colliders added/teleported since the last step ([#280](https://github.com/Duylamneuuu/Kinetra/pull/280))
- **reference-game**: `ArenaGameManager.damageDealt` counts `enemy.hurt`, not attempted hits on a defeated enemy ([#279](https://github.com/Duylamneuuu/Kinetra/pull/279))
- **editor**: `EditorSession` drops an undo token the bus no longer holds instead of blocking older edits forever ([#277](https://github.com/Duylamneuuu/Kinetra/pull/277))
- **asset-pipeline**: `SourceAssetWatcher` keeps waiting for a source that is missing (moved aside, deleted, not created yet) instead of going deaf ([#276](https://github.com/Duylamneuuu/Kinetra/pull/276))
- **animation**: `skeletonSignature`/`retargetCacheKey` no longer collide for bone names with separators, NaN/Infinity or `__proto__` ([#272](https://github.com/Duylamneuuu/Kinetra/pull/272))
- **input**: `InputRouter` constructor validates the map (shape, unique ids, bindings) instead of failing later with TypeErrors ([#271](https://github.com/Duylamneuuu/Kinetra/pull/271))
- **verification**: visual-baseline CLI rejects empty frame dirs, reports corrupt PNGs and *.png directories as exit 2, rejects empty --only ([#257](https://github.com/Duylamneuuu/Kinetra/pull/257))
- **renderer-three**: IkController copies pole/weight on setTarget and returns copies from observe() ([#270](https://github.com/Duylamneuuu/Kinetra/pull/270))
- **animation**: validateAnimationGraph reports malformed graph shapes as diagnostics instead of throwing ([#264](https://github.com/Duylamneuuu/Kinetra/pull/264))
- **renderer-three**: crossfading a clip into itself restarts it instead of stopping it when the fade ends ([#268](https://github.com/Duylamneuuu/Kinetra/pull/268))
- **asset-pipeline,blender-bridge**: retry stale dependents when the root is a noop, reject NaN/negative creativeUnitsCost, validate NodeProcessRunner maxOutputChars ([#267](https://github.com/Duylamneuuu/Kinetra/pull/267))
- **command-bus,audio,save-state**: CommandBus rejects invalid initialRevision; AudioMixerModel.effectiveGain never Infinity/NaN; JsonDocumentStore.save rejects unserializable values ([#263](https://github.com/Duylamneuuu/Kinetra/pull/263))
- **blender-bridge**: recipe settings can no longer choose the executable/script to spawn unless the host opts in (refs #145) ([#251](https://github.com/Duylamneuuu/Kinetra/pull/251))
- **player**: audio controller drops a play() that outlives init()/reset(), prunes finished playbacks, releases nodes on failed start ([#249](https://github.com/Duylamneuuu/Kinetra/pull/249))
- **animation**: retarget bake/inspect tolerate profiles without a bones object; a cache write failure no longer discards a baked clip ([#246](https://github.com/Duylamneuuu/Kinetra/pull/246))
- **blender-bridge**: importer removes the <staging>.manifest.json / .glb sidecars it leaves in the asset directory ([#247](https://github.com/Duylamneuuu/Kinetra/pull/247))
- **player**: runtime snapshots and saves keep entity/asset id "__proto__"; entity order by code unit instead of localeCompare (#228) ([#242](https://github.com/Duylamneuuu/Kinetra/pull/242))
- **orb-run**: headless probe step/wait/hold bounds, stuck action on rejected hold, input dropped while paused (refs #145) ([#233](https://github.com/Duylamneuuu/Kinetra/pull/233))

### Tests

- **command-bus**: edge contracts — cross-scene ids, scene.create validation, non-JSON values, undo token strictness, defensive copies (+13 tests) ([#293](https://github.com/Duylamneuuu/Kinetra/pull/293))
- **mcp-server,save-state**: initialRevision validation and JsonDocumentStore.save unserializable values (#266) ([#289](https://github.com/Duylamneuuu/Kinetra/pull/289))
- **verification**: runtime-probe delegation edge cases ([#283](https://github.com/Duylamneuuu/Kinetra/pull/283))
- **reference-game**: encounter edge cases (frame sanitising, lockdown win/lose, damage payloads, player input) ([#265](https://github.com/Duylamneuuu/Kinetra/pull/265))
- **navigation-recast**: geometry/property coverage + bake rejects non-array geometry with RangeError ([#260](https://github.com/Duylamneuuu/Kinetra/pull/260))
- **asset-pipeline**: AssetHotReloadCoordinator transaction, runtime-reload and lifecycle branches (#209) ([#259](https://github.com/Duylamneuuu/Kinetra/pull/259))
- **verification**: packaged-resolver edge cases and FakeVisualCritiqueProvider branches (refs #152) ([#256](https://github.com/Duylamneuuu/Kinetra/pull/256))
- **asset-pipeline**: AssetReimportService failure/cleanup/event branches and default Node file system (#209) ([#254](https://github.com/Duylamneuuu/Kinetra/pull/254))

### Documentation

- **docs**: CHANGELOG through #287, STATUS snapshot ([#278](https://github.com/Duylamneuuu/Kinetra/pull/278))
- **docs**: CHANGELOG through #260, HANDOFF 25-26, STATUS snapshot ([#269](https://github.com/Duylamneuuu/Kinetra/pull/269))
- **docs**: verification visual-baseline section and renderer-three animation-events section, both doc-checked ([#253](https://github.com/Duylamneuuu/Kinetra/pull/253))
- **docs**: CHANGELOG through #227, HANDOFF 22-24, blender-bridge README with executed example, UNDO_EXPIRED in agent guide ([#245](https://github.com/Duylamneuuu/Kinetra/pull/245))

## 2026-10-09

### Added

- **verification**: visual baseline management: `visual-baseline.ts` stores sha256 + dHash + size per named frame, `check` reports identical/similar/mismatch/missing with a diff artifact, `update` needs `--confirm` and refuses under CI (#100) ([#248](https://github.com/Duylamneuuu/Kinetra/pull/248))
- **orb-run**: content through the asset pipeline (slice 7) ([#220](https://github.com/Duylamneuuu/Kinetra/pull/220))
- **orb-run**: the runner animates from gameplay: per-step locomotion blend + foot IK observer (`OrbRunAnimator`), `state.animation.*` in the headless probe and an `animation` acceptance manifest (slice 8) ([#238](https://github.com/Duylamneuuu/Kinetra/pull/238))
- **orb-run**: HUD contract with acceptance manifests (slice 6) ([#188](https://github.com/Duylamneuuu/Kinetra/pull/188))
- **renderer-three**: `ThreeSceneRuntime` drives animation events from its mixers (`setAnimationEvents`, `onAnimationEvent`, bounded event log, diagnostics) (#90 part 2) ([#236](https://github.com/Duylamneuuu/Kinetra/pull/236))
- **animation**: animation events contract (#90 part 1): validation + deterministic clip event tracker ([#180](https://github.com/Duylamneuuu/Kinetra/pull/180))
- **orb-run**: audio cues with a headless audio service (slice 5) ([#179](https://github.com/Duylamneuuu/Kinetra/pull/179))
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

- **renderer-three**: crossfadeAnimation rejects non-finite blendSeconds/speed instead of freezing a fade or poisoning the mixer ([#232](https://github.com/Duylamneuuu/Kinetra/pull/232))
- **asset-pipeline**: watcher drops checks overtaken by stop/remove/re-point; coordinator survives a throwing runtime updateAsset ([#243](https://github.com/Duylamneuuu/Kinetra/pull/243))
- **core**: ScriptHost keeps empty-message script errors visible and explains async validateRestoreState ([#240](https://github.com/Duylamneuuu/Kinetra/pull/240))
- **player**: startArenaGame joins a pending start instead of double-starting the runtime (#230) ([#239](https://github.com/Duylamneuuu/Kinetra/pull/239))
- **verification**: concurrent first requests share one Electron startup instead of spawning duplicates ([#235](https://github.com/Duylamneuuu/Kinetra/pull/235))
- **save-state**: save slots can no longer alias settings files; SettingsStore.save rejects non-finite gains ([#227](https://github.com/Duylamneuuu/Kinetra/pull/227))
- **command-bus**: bound undo history and event log (maxUndoDepth/maxEventLogLength), UNDO_EXPIRED for evicted tokens; drop redundant per-command clone (#206) ([#226](https://github.com/Duylamneuuu/Kinetra/pull/226))
- **mcp-server**: bound LocalRuntimeHost log buffer (MAX_LOCAL_RUNTIME_LOG_ENTRIES) ([#224](https://github.com/Duylamneuuu/Kinetra/pull/224))
- **player**: bridge answers malformed requests with a structured error instead of dropping them (#208) ([#223](https://github.com/Duylamneuuu/Kinetra/pull/223))
- **animation**: validateSkeletonProfile/buildRetargetPlan tolerate profiles without a bones object; validateClipMetadata rejects non-object clips (follow-up to #186) ([#201](https://github.com/Duylamneuuu/Kinetra/pull/201))
- **verification**: empty/unusable performance budgets no longer pass; probe wait rejects NaN/Infinity/oversized delays; snapshot indexes __proto__ entities ([#221](https://github.com/Duylamneuuu/Kinetra/pull/221))
- **animation**: ClipEventTracker.finished follows the move direction (reverse parked at 0 reports finished) ([#219](https://github.com/Duylamneuuu/Kinetra/pull/219))
- **animation**: unwrap root-motion sample yaw so a turn through 180 degrees does not produce a 2pi delta ([#217](https://github.com/Duylamneuuu/Kinetra/pull/217))
- **blender-bridge**: timeout kills the whole process group and no longer waits forever on inherited stdio pipes ([#214](https://github.com/Duylamneuuu/Kinetra/pull/214))
- **project-model**: validateProject requires a non-empty string scene name (scene.name.empty) ([#195](https://github.com/Duylamneuuu/Kinetra/pull/195))
- **reference-game**: reject unreachable Arena save states; freeze run stats after win/loss ([#213](https://github.com/Duylamneuuu/Kinetra/pull/213))
- **navigation**: validate query inputs and reject garbage navmesh bytes before they reach WASM ([#204](https://github.com/Duylamneuuu/Kinetra/pull/204))
- **renderer-three**: reloadAsset no longer resurrects/overwrites a model detached or re-attached while the new bytes resolve; vec3Value rejects NaN/Infinity ([#199](https://github.com/Duylamneuuu/Kinetra/pull/199))
- **audio**: reject non-boolean muted, cap createSyntheticWav payload size ([#203](https://github.com/Duylamneuuu/Kinetra/pull/203))
- **asset-pipeline**: AssetDatabase ordering by code unit, not host-locale localeCompare ([#198](https://github.com/Duylamneuuu/Kinetra/pull/198))
- **command-bus,core**: bound JSON depth (cyclic payloads), reject empty transactions, prefab overrides with reserved/inherited component names ([#196](https://github.com/Duylamneuuu/Kinetra/pull/196))
- **save-state**: v1→v2 migration keeps entity id "__proto__" and rejects malformed data with a descriptive error ([#192](https://github.com/Duylamneuuu/Kinetra/pull/192))
- **project-model**: bound JSON nesting depth and make parent checks/cycle detection linear ([#193](https://github.com/Duylamneuuu/Kinetra/pull/193))
- **verification**: cap pixelDiffThreshold at 765 in the manifest schema; surface VisualError code/details on step results; runner-level visual tests ([#169](https://github.com/Duylamneuuu/Kinetra/pull/169))
- **animation**: skeleton/clip validators tolerate null bones and NaN times; locale-independent ordering ([#186](https://github.com/Duylamneuuu/Kinetra/pull/186))
- **core**: PlayerControllerScript rejects negative/fractional counters; restoreScriptState rolls back a throwing commit ([#184](https://github.com/Duylamneuuu/Kinetra/pull/184))
- **project-model**: canonical key order so a project serializes to the same bytes regardless of property assignment order ([#183](https://github.com/Duylamneuuu/Kinetra/pull/183))
- **animation**: retarget cache key includes rest poses; dotted bone names; concurrent cache writes; metadata_mismatch reason ([#182](https://github.com/Duylamneuuu/Kinetra/pull/182))
- **asset-pipeline,verification**: serialize overlapping reimports of one asset, release watcher resources on stop(), recover from a failed coordinator start, reject NaN in percentile maths ([#178](https://github.com/Duylamneuuu/Kinetra/pull/178))
- **mcp-server**: roll back an applied command when persisting the project fails ([#177](https://github.com/Duylamneuuu/Kinetra/pull/177))
- **blender-bridge**: kill hung Blender after a timeout and report blender.timeout ([#174](https://github.com/Duylamneuuu/Kinetra/pull/174))
- **renderer-three**: close async races in template cache and attachModel/loadModels (stale overwrite, dispose-during-load, overlapping attaches) ([#175](https://github.com/Duylamneuuu/Kinetra/pull/175))
- **save-state**: corrupt settings file falls back to defaults instead of blocking player start-up ([#168](https://github.com/Duylamneuuu/Kinetra/pull/168))
- **physics**: validate body input, stop orphan rigid bodies and leaked worlds; +15 tests ([#167](https://github.com/Duylamneuuu/Kinetra/pull/167))
- **command-bus**: component lookups use own properties so names like toString/constructor neither match every entity nor crash queries ([#162](https://github.com/Duylamneuuu/Kinetra/pull/162))
- **player**: validate runtime.step steps/deltaSeconds; ignore non-finite animation deltas ([#123](https://github.com/Duylamneuuu/Kinetra/pull/123))
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

- **mcp-server**: FileProjectStore async write-failure, mkdir-failure and load-error branches (#145) ([#237](https://github.com/Duylamneuuu/Kinetra/pull/237))
- **orb-run**: keyboard/gamepad input parity and save-restart-finish gate through the real InputRouter (#92 partial) ([#234](https://github.com/Duylamneuuu/Kinetra/pull/234))
- **asset-pipeline**: inspectGlb and normalizeGlb direct tests ([#225](https://github.com/Duylamneuuu/Kinetra/pull/225))
- **project-model**: migration and schemaVersion edge cases (v0 shapes, NaN/Infinity/fractional versions, input immutability) ([#222](https://github.com/Duylamneuuu/Kinetra/pull/222))
- **mcp-server**: acceptance input validation, scene ordering, diffSince, dryRun and LocalRuntimeHost contract (+9 tests) ([#215](https://github.com/Duylamneuuu/Kinetra/pull/215))
- **scripts**: end-to-end tests for check-foundation and check-bundle-size CLIs ([#207](https://github.com/Duylamneuuu/Kinetra/pull/207))
- **scripts**: extract doc-check parser and test it; malformed doc-check fences now fail instead of being skipped ([#194](https://github.com/Duylamneuuu/Kinetra/pull/194))
- **physics-rapier**: determinism/fuzz replay, advance() slicing, step(dt) restore, dynamic material validation, controller release on remove ([#190](https://github.com/Duylamneuuu/Kinetra/pull/190))
- **asset-pipeline**: edge cases for validateAssetRecord, inspectGlb and normalizeGlb (+17 tests) ([#181](https://github.com/Duylamneuuu/Kinetra/pull/181))
- **scripts**: unit + fixture tests for the license gate (extract license-policy.mjs) ([#176](https://github.com/Duylamneuuu/Kinetra/pull/176))
- **verification**: unit-test AcceptanceRunner screenshot, visual, critique and performance steps ([#164](https://github.com/Duylamneuuu/Kinetra/pull/164))
- **verification**: unit-test KinetraRuntimeProbe fallbacks and runProcessSmoke ([#147](https://github.com/Duylamneuuu/Kinetra/pull/147))
- **repo**: add dependency-free unit-test coverage report (`pnpm coverage`) ([#139](https://github.com/Duylamneuuu/Kinetra/pull/139))
- **animation**: seeded property tests for blend space, IK and morph-target contracts ([#115](https://github.com/Duylamneuuu/Kinetra/pull/115))

### Documentation

- **docs**: CHANGELOG entry for #191 (input/audio/save-state READMEs) ([#200](https://github.com/Duylamneuuu/Kinetra/pull/200))
- **docs**: READMEs for asset-pipeline, verification, renderer-three; CHANGELOG through #194; HANDOFF 20-21 ([#202](https://github.com/Duylamneuuu/Kinetra/pull/202))
- **docs**: Mermaid package graph and authoring/proof sequence in SYSTEM_MAP ([#197](https://github.com/Duylamneuuu/Kinetra/pull/197))
- **repo**: real READMEs for input, audio and save-state with doc-checked examples ([#191](https://github.com/Duylamneuuu/Kinetra/pull/191))
- **docs**: READMEs for command-bus, project-model, core (executable examples); CHANGELOG through #160 ([#165](https://github.com/Duylamneuuu/Kinetra/pull/165))
- **docs**: executable doc examples (`pnpm check:docs`), animation + MCP agent guides, CHANGELOG, HANDOFF through #75 ([#116](https://github.com/Duylamneuuu/Kinetra/pull/116))

### Maintenance

- **deps**: bump @modelcontextprotocol/server 2.0.0 -> 2.3.1 ([#241](https://github.com/Duylamneuuu/Kinetra/pull/241))
- **ci**: add report-only coverage workflow that uploads the coverage artifact ([#163](https://github.com/Duylamneuuu/Kinetra/pull/163))
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
