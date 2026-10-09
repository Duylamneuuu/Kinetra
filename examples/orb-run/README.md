# Orb Run (dogfood sample game)

Orb Run is a small game built *with* Kinetra to find out where the engine is
pleasant and where it hurts. It is developed in slices; each slice ships with
automated semantic acceptance (no human looking at a screen).

**Rules.** Collect the three orbs, then reach the exit pad before the clock
runs out. The exit stays locked until every orb is collected. All tuning lives
in the `OrbRunRules` component on the `OrbRunManager` entity (time limit,
pickup radius, exit radius, player speed, arena size), so an agent can rebalance
the game with one `entity.patch` and no code change.

## Layout

| File | What it is |
| --- | --- |
| `src/ids.ts` | Stable ids (`stableId`), script ids, semantic actions, gameplay events. |
| `src/authoring.ts` | The authoring plan: the exact MCP tool calls (`scene.create`, `entity.create`, `entity.patch`) that build the game from an empty project, plus `createOrbRunProject()` which replays the same plan through the typed `CommandBus`. |
| `orb-run.kinetra.json` | Canonical project snapshot. The MCP-authored file and the command-bus project must both equal it byte for byte. Regenerate with `pnpm --filter @kinetra/example-orb-run snapshot` after changing the plan. |
| `src/scripts.ts` | Gameplay scripts (`OrbRunPlayer`, `OrbRunOrb`, `OrbRunManager`) on the `@kinetra/core` `GameScript` contract, with save/restore validation, and `createOrbRunScriptRegistry()`. |
| `src/simulation.ts` | `HeadlessSceneSimulation`: binds `ScriptHost` to an engine-free runtime transform table so gameplay runs in plain Node at a fixed step. |
| `src/game.ts` | Run summary, a semantic-input playtest bot (`walkTo`), the winning route, save capture/restore. |
| `src/acceptance-probe.ts` | `OrbRunHeadlessProbe`: a `@kinetra/verification` `RuntimeProbe` over the headless simulation, so the engine's `AcceptanceRunner` runs Orb Run manifests in plain Node (virtual fixed-step time; frames/vector input/other scenes fail loudly). |
| `acceptance/*.acceptance.json` | Gameplay contracts as engine `AcceptanceManifest`s: `win`, `timeout`, `save-load`, `audio`, `hud`, `hud-timeout`. |
| `src/hud.ts` | HUD contract: `computeOrbRunHud` (pure state → JSON model), `buildOrbRunHud`, `renderOrbRunHudText`, `formatClock`, `compassFor`. |
| `src/locomotion.ts`, `src/foot-ik.ts` | Pure animation contracts: speed-driven locomotion blend space and two-bone foot placement (`planFootPlacement`). |
| `src/audio.ts` | Audio asset ids, synthetic WAV bytes, the `master/music/sfx` mixer, and `HeadlessAudioService` (records cues, simulation-clock playback). |
| `test/` | `authoring.test.ts` (MCP + command bus), `gameplay.test.ts` (win/lose/clamp/determinism/save), `acceptance.test.ts` (manifests on `AcceptanceRunner`, negative cases). |

## Slices

1. **Slice 1 (this PR): authored over MCP, playable headless.** Proof:
   - authored from an empty project through the real MCP server over the in-memory transport, one revision per tool call with `expectedProjectRevision`; the file written by `FileProjectStore` equals `orb-run.kinetra.json`;
   - `entity.query` with field selection finds every scripted entity; stale revisions and duplicate ids fail with `STALE_REVISION` / `ENTITY_ALREADY_EXISTS` and leave the file untouched; a rules patch is undone back to the original bytes;
   - the playtest bot wins with semantic input only (`player.move*`), orbs are collected once each in route order, the exit unlocks after the last orb, and the finished run freezes input and clock;
   - reaching the exit early does not win; idling loses exactly once; the player is clamped to the arena; two runs with the same input are identical;
   - a run saved mid-way, JSON round-tripped and restored into a fresh simulation finishes with the same outcome; corrupt saves are rejected without state changes;
   - patching `OrbRunRules.timeLimitSeconds` to 5 through the command bus makes the same route lose.

   Not proven yet: rendering, the Electron player, packaged builds.
2. **Slice 2: acceptance as engine manifests.** `acceptance/{win,timeout,save-load}.acceptance.json` run on `AcceptanceRunner` through `OrbRunHeadlessProbe`. Proof: every step of every manifest passes; a missing path gives a structured `missing_path` diagnostic; screenshot steps fail (no renderer) instead of passing; corrupt saves fail `save.load` without touching the running game; a 5 s clock patched through the command bus makes the *same* win manifest fail at the third-orb check; a typo'd script id fails `assert.logAbsent`.
   Snapshot paths: `state.game.<status|collectedCount|totalOrbs|exitUnlocked|elapsedSeconds|remainingSeconds|step>`, `state.entities.<Name>.position.<i>` / `.script.*`, `state.events.<orbCollected|exitUnlocked|won|lost>`, `state.paused`.
3. **Slice 3: locomotion blend space.** `src/locomotion.ts`: a pure 1D blend space (idle/walk/run at 0 / 1.5 / 4 m/s) on `@kinetra/animation`, driven by horizontal speed. Proof: valid definition, exact weights at sample speeds, blended weights sum to 1, negative speed clamps to idle.
4. **Slice 4: foot placement with the engine's two-bone IK.** `src/foot-ik.ts` (`planFootPlacement`): lowers the pelvis to the lowest foot's ground, then solves both legs with `solveTwoBoneIk`, knees forward. Proof (pure contract, no renderer): flat ground plants both ankles with exact bone lengths; a step plants only that foot higher; a drop-off lowers the pelvis by exactly the drop; a ledge out of reach reports `reachable:false`/`converged:false` and the leg stretches toward it; deterministic; non-finite input throws. Not proven: applying the solved pose to a real skinned model in the player (needs #79).
5. **Slice 5: audio cues.** `src/audio.ts`: deterministic synthetic WAV clips (pickup pitch ladder C5/E5/G5, exit chime, win, lose), a `master → {music, sfx}` mixer on the engine's `AudioMixerModel`, and `HeadlessAudioService` (a `GameScriptAudioService` that records cues and derives playback progress from the simulation clock). `OrbRunManager` plays cues through `context.audio` on the sfx bus (fire-and-forget; a refused play is an `orbRun.audioFailed` warning, never a crash). Proof: a winning run plays exactly pickup 1, 2, 3, chime, win in step order at the authored gains (sfx 0.9 × instance gain); a timeout plays only the lose cue and a finished run is silent; a muted sfx bus still starts cues but at effective gain 0 without affecting gameplay; restoring a save replays nothing and the ladder resumes from the saved count; a service that refuses everything leaves the run winnable. `OrbRunHeadlessProbe` now implements `audio.play/stop/setBusGain/setBusMuted` (refusals throw so manifests fail loudly), reports `state.audio.<playedCount|played.<assetId>|failedCount|cues.<n>.*|buses.<id>.*|playbacks.<n>.*>` and `audio.played` logs; `acceptance/audio.acceptance.json` asserts all of it on `AcceptanceRunner`. Not proven: real decoding/Web Audio output in the player (needs #79), mixer state across a save/load (a fresh simulation starts with the authored mixer).
6. **Slice 6 (this PR): HUD contract.** `src/hud.ts`: `computeOrbRunHud` is a pure function of the run summary + authored rules + target positions and returns a plain JSON model (`objective`, `orbs`, `timer`, `exit`, `marker`, `banner`); `buildOrbRunHud(simulation)` feeds it from a running headless game (rules read from the authored `OrbRunRules` component). Timer: `m:ss` rounded *up* (never `0:00` with time left, immune to 1/30 s float drift), `fraction` of the limit, urgency `normal` → `warning` (≤ half the clock) → `critical` (≤ 5 s) → `expired`; a won run stays `normal`. Marker: nearest uncollected orb, then the exit once every orb is in (distance in metres, clockwise bearing from forward `-z`, 8-point compass; ties break on entity id so it never flickers); none when the run is over. Banner: win/loss title + subtitle. Proof: pure unit tests for every threshold; the opening HUD of the authored game is exact (`Orbs 0/3 | 0:20 | Exit locked | Orb SE 5.7 m`); a full winning run tracks orbs/objective/marker and freezes with the banner; an idle run walks `normal → warning → critical → expired` and shows the loss; a HUD rebuilt from a JSON round-tripped save equals the saved one; a 60 s clock patched through the command bus reads `1:00`. `OrbRunHeadlessProbe` now exposes `state.hud.*`; `acceptance/hud.acceptance.json` (winning route) and `acceptance/hud-timeout.acceptance.json` (idle until the loss) assert it on `AcceptanceRunner`, and an 8 s clock fails the first timer check. Not proven: drawing the HUD (needs a UI layer in the player, see engine requests) and the Electron player (needs #79).
7. Next: the same manifests in the real Electron player (blocked on #79), assets via the asset pipeline, packaged smoke.

## Engine requests found while building this

Filed as GitHub issues labelled `dx`: #79 (player can't load a second game), #80 (headless simulation, component access, script queries, MCP test client), #81 (component payload validation); label `bug`: #122 (`AcceptanceRunner` passes steps whose optional probe method is missing).

- No engine-owned headless simulation: the player binds script transforms to `THREE.Object3D` positions, so gameplay can't run in Node without a renderer. `src/simulation.ts` is a stop-gap that could move into `@kinetra/core`.
- `GameScriptContext` can't read the entity's authored components, so tuning data (`OrbRunRules`) has to be read from the project by the script factory.
- No scene query by component or script (`findEntityByName` only), so the manager gets its orb list from the factory.
- The Electron player hard-codes the Arena scripts and boots `createArenaProject()`; there is no way for an example package to register its scripts and project.
- No exported MCP test client; tests copy a JSON-RPC shim from `packages/mcp-server/test`.
- `AcceptanceRunner` silently passes `save.*`, `runtime.pause/resume`, `animation.*`, `audio.*`, `navigation.*` steps when the probe lacks the method (#122); there is no engine headless `RuntimeProbe`, so `src/acceptance-probe.ts` is a stop-gap.
- No headless audio: `apps/player`'s `AudioController` is bound to Web Audio and `@kinetra/audio` only has the mixer model, so verifying "which cue played at what gain" in Node needs a service like `HeadlessAudioService` (`src/audio.ts`) that could move into `@kinetra/audio`.
- `GameScriptAudioService` only has `play`; scripts can't `stop`, set bus gain/mute or read playback state, so a game can't implement e.g. a pause-duck or "stop music on win" through its context.
- Component payloads (`Primitive.kind`, `Transform` shape) aren't validated at the command-bus boundary; a bad `Primitive.kind` only fails when the renderer instantiates it.
- No UI/HUD layer contract: the player only has a fixed shell overlay (`apps/player/src/shell.ts`), so a game can't declare HUD widgets and have the player draw them from state. `src/hud.ts` defines its own JSON HUD model; a draw-from-model contract in the player would let the same `state.hud` drive the real overlay.
