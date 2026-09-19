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
