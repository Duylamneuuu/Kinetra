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
| `acceptance/*.acceptance.json` | Gameplay contracts as engine `AcceptanceManifest`s: `win`, `timeout`, `save-load`. |
| `src/locomotion.ts`, `src/foot-ik.ts` | Pure animation contracts: speed-driven locomotion blend space and two-bone foot placement (`planFootPlacement`). |
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
4. **Slice 4 (this PR): foot placement with the engine's two-bone IK.** `src/foot-ik.ts` (`planFootPlacement`): lowers the pelvis to the lowest foot's ground, then solves both legs with `solveTwoBoneIk`, knees forward. Proof (pure contract, no renderer): flat ground plants both ankles with exact bone lengths; a step plants only that foot higher; a drop-off lowers the pelvis by exactly the drop; a ledge out of reach reports `reachable:false`/`converged:false` and the leg stretches toward it; deterministic; non-finite input throws. Not proven: applying the solved pose to a real skinned model in the player (needs #79).
5. Next: the same manifests in the real Electron player (blocked on #79), audio, assets via the asset pipeline, HUD, packaged smoke.

## Engine requests found while building this

Filed as GitHub issues labelled `dx`: #79 (player can't load a second game), #80 (headless simulation, component access, script queries, MCP test client), #81 (component payload validation); label `bug`: #122 (`AcceptanceRunner` passes steps whose optional probe method is missing).

- No engine-owned headless simulation: the player binds script transforms to `THREE.Object3D` positions, so gameplay can't run in Node without a renderer. `src/simulation.ts` is a stop-gap that could move into `@kinetra/core`.
- `GameScriptContext` can't read the entity's authored components, so tuning data (`OrbRunRules`) has to be read from the project by the script factory.
- No scene query by component or script (`findEntityByName` only), so the manager gets its orb list from the factory.
- The Electron player hard-codes the Arena scripts and boots `createArenaProject()`; there is no way for an example package to register its scripts and project.
- No exported MCP test client; tests copy a JSON-RPC shim from `packages/mcp-server/test`.
- `AcceptanceRunner` silently passes `save.*`, `runtime.pause/resume`, `animation.*`, `audio.*`, `navigation.*` steps when the probe lacks the method (#122); there is no engine headless `RuntimeProbe`, so `src/acceptance-probe.ts` is a stop-gap.
- Component payloads (`Primitive.kind`, `Transform` shape) aren't validated at the command-bus boundary; a bad `Primitive.kind` only fails when the renderer instantiates it.
