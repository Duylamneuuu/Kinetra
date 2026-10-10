# Changelog

All notable changes merged to `main`, newest first. Kinetra has no tagged releases yet, so entries are grouped by commit date.
Entries are derived from squash-merge commit titles; the PR number links to the full description and verification evidence.
What is actually *proven* (and at which level) is tracked in [`docs/STATUS.md`](docs/STATUS.md), not here.

Maintenance: when a PR merges, add one line under its commit date in the matching section, using the PR title (`ci`/`build`/`chore` go under Maintenance).

## 2026-10-10

### Added

- **editor**: `@kinetra/editor` headless observer core (#104 part 1): `buildHierarchy` + `EditorSession` that edits only through the command bus, with editor-vs-MCP parity tests ([#258](https://github.com/Duylamneuuu/Kinetra/pull/258))
- **orb-run**: content is part of the acceptance gate (slice 9) ([#250](https://github.com/Duylamneuuu/Kinetra/pull/250))

### Fixed

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
