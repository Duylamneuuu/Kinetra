# Project model

The project model is the authoritative authoring state.

## Design requirements

- text-first;
- schema-versioned;
- stable IDs;
- deterministic serialization where practical;
- meaningful Git diffs;
- migration support;
- no dependency on editor UI state.

## Intended game layout

~~~text
my-game/
├─ game.project.json
├─ scenes/
│  ├─ boot.scene.json
│  └─ level-01.scene.json
├─ prefabs/
│  ├─ player.prefab.json
│  └─ enemy.prefab.json
├─ animations/
│  └─ player.animgraph.json
├─ input/
│  └─ default.input.json
├─ scripts/
│  ├─ PlayerController.ts
│  └─ EnemyController.ts
├─ assets/
│  ├─ source/
│  ├─ imported/
│  └─ generated/
├─ import/
│  └─ player.asset.json
├─ tests/
│  └─ acceptance.game.json
└─ .engine/
   ├─ project-memory.md
   ├─ asset-index.json
   ├─ decisions.json
   └─ known-issues.json
~~~

Runtime scenes reference imported content by asset ID rather than arbitrary source paths.

## Project vs save-game state

Editor/project data and player save-game data are separate schemas with separate migration lifecycles. A scene definition must not accidentally become a save file format.

## Three.js boundary

Three.js objects are runtime projections. They are not serialized directly as the canonical project database.
