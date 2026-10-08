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
| `test/` | `authoring.test.ts` (MCP + command bus), `gameplay.test.ts` (win/lose/clamp/determinism/save). |

## Slices

1. **Slice 1 (this PR): authored over MCP, playable headless.** Proof:
   - authored from an empty project through the real MCP server over the in-memory transport, one revision per tool call with `expectedProjectRevision`; the file written by `FileProjectStore` equals `orb-run.kinetra.json`;
   - `entity.query` with field selection finds every scripted entity; stale revisions and duplicate ids fail with `STALE_REVISION` / `ENTITY_ALREADY_EXISTS` and leave the file untouched; a rules patch is undone back to the original bytes;
   - the playtest bot wins with semantic input only (`player.move*`), orbs are collected once each in route order, the exit unlocks after the last orb, and the finished run freezes input and clock;
   - reaching the exit early does not win; idling loses exactly once; the player is clamped to the arena; two runs with the same input are identical;
   - a run saved mid-way, JSON round-tripped and restored into a fresh simulation finishes with the same outcome; corrupt saves are rejected without state changes;
   - patching `OrbRunRules.timeLimitSeconds` to 5 through the command bus makes the same route lose.

   Not proven yet: rendering, the Electron player, packaged builds.
2. Next: run Orb Run in the real Electron player with an `AcceptanceManifest` (needs the player to load a game's scripts, see below).
3. Later: an animated character (blend space driven by speed, IK foot placement), audio, assets via the asset pipeline, HUD, packaged smoke.

## Engine requests found while building this

Filed as GitHub issues labelled `dx`: #79 (player can't load a second game), #80 (headless simulation, component access, script queries, MCP test client), #81 (component payload validation).

- No engine-owned headless simulation: the player binds script transforms to `THREE.Object3D` positions, so gameplay can't run in Node without a renderer. `src/simulation.ts` is a stop-gap that could move into `@kinetra/core`.
- `GameScriptContext` can't read the entity's authored components, so tuning data (`OrbRunRules`) has to be read from the project by the script factory.
- No scene query by component or script (`findEntityByName` only), so the manager gets its orb list from the factory.
- The Electron player hard-codes the Arena scripts and boots `createArenaProject()`; there is no way for an example package to register its scripts and project.
- No exported MCP test client; tests copy a JSON-RPC shim from `packages/mcp-server/test`.
- Component payloads (`Primitive.kind`, `Transform` shape) aren't validated at the command-bus boundary; a bad `Primitive.kind` only fails when the renderer instantiates it.
