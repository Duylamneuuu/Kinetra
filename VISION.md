# Vision

## One sentence

**Kinetra is a game engine whose primary operator is an AI agent, and whose proof of success is a tested, packaged, complete game rather than generated source code or an attractive screenshot.**

## Product principles

1. **Agent-first, not human-editor-first.** Every important authoring operation must be possible through typed commands/queries without GUI automation.
2. **The GUI is an observer.** Humans need a viewport, hierarchy, inspector, logs, profiler, Play/Stop, and override tools. They do not need a Unity-sized interaction surface.
3. **Structured state beats hidden state.** Project state must be serializable, versioned, diffable and Git-friendly.
4. **One mutation path.** Editor UI and agents call the same command bus. Direct authoring mutation of raw Three.js objects is forbidden.
5. **Runtime truth beats agent claims.** Run the game, inspect it, drive it, capture it and test the packaged executable.
6. **Complete beats impressive.** Menus, settings, input, save/load, audio, win/lose and packaging matter more than another rendering demo.
7. **Use proven specialists.** Three.js renders; Rapier does physics; Recast does navigation; Blender authors 3D; glTF is the interchange format.
8. **AI-readable by default.** Text schemas, semantic IDs, narrow queries, structured logs and explicit failure states are product features.
9. **Provider-agnostic.** MCP/JSON Schema is the durable contract; model integrations stay outside the runtime kernel.
10. **Licensing is a build constraint.** Agents may not casually copy from copyleft donors.

## North-star workflow

A new capable coding agent should be able to enter an unfamiliar Kinetra repo, read a compact engine guide, inspect only the state it needs, create a game, test it and produce a working executable without a human teaching it how to use the editor.

## Definition of product success

Kinetra becomes meaningfully useful when it can repeatedly produce a modest but complete 3D game that includes:

- boot/splash and main menu;
- a controllable animated player;
- physics and camera;
- enemies/NPC navigation;
- interaction/combat or another real core loop;
- UI and audio;
- pause/settings;
- save/load;
- win and lose states;
- keyboard + controller;
- a packaged Windows build;
- automated acceptance tests against that packaged build.

A polished editor without this loop is not success.
