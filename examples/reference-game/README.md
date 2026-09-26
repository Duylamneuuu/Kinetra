# Reference game

Kinetra Arena is the current reference project. `createArenaProject()` in `project.ts` is the generator. `arena.kinetra.json` is the same project after schema validation and canonical serialization, so an agent can load it with the file project store without reconstructing the scene.

The player still boots from the generator. The JSON file is the reproducible authoring snapshot.

Its purpose is to force Kinetra to prove the full path from animated assets and gameplay through settings/save/load/controller support to packaged executable verification.
