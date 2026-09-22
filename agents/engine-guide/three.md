# Kinetra engine guide for coding/game agents

## Mental model

Kinetra is a TypeScript + Three.js game engine controlled primarily through structured commands and MCP.

Do not mutate raw editor/runtime Three.js objects as authoring state.

## Canonical choices

- language: TypeScript;
- rendering: Three.js;
- physics: Rapier;
- navigation: Recast/Detour via recast-navigation-js;
- 3D interchange: glTF/GLB;
- DCC: Blender;
- desktop packaging: Electron initially;
- project data: versioned JSON/JSONC + TS;
- testing: runtime queries + semantic input + logs + screenshots + packaged build.

## Work loop

1. read acceptance criteria;
2. query only relevant project state;
3. make bounded changes;
4. run;
5. inspect structured state/logs;
6. drive semantic input;
7. capture screenshot only when visual evidence helps;
8. fix;
9. run acceptance;
10. package and test the executable when required.

Never call a game complete from compile success alone.

## Kinetra Arena observation

`state.game` below is filled when an acceptance manifest runs the reference game on the Electron player. The default MCP `runtime.start` host is a local scene graph and does not produce this session.

These paths are the ones the existing Electron suites already assert:

- `state.game.status` is `playing`, `won`, or `lost`
- `state.game.playerHealth`
- `state.game.enemyHealth`
- `state.game.goalReached`
- `state.game.run.status`
- `state.game.objectives.length`
- `state.game.objectives.0.id`
- `state.game.objectives.0.completed`
- `state.game.objectives.1.id`
- `state.game.objectives.2.id`
- `state.game.challenge.active`
- `state.game.challenge.status`

Drive the player with semantic action ids, not key codes:

- `player.moveForward`
- `player.moveBackward`
- `player.moveLeft`
- `player.moveRight`
- `player.attack`
- `game.pause`

`player.jump`, `ui.confirm`, and `ui.back` are also in the engine default input map. Arena movement and combat use the list above. Send them as acceptance `input` steps or `runtime.injectInput` on a host that actually simulates the game.
