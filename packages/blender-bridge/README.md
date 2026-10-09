# @kinetra/blender-bridge

Thin headless/Python automation boundary for Blender inspection, export and eventually structured model/rig/animation operations.

## Error and input contract

- `blenderHeadlessArgs` is pure and deterministic. Every path option must be a non-empty string without NUL characters; a relative path starting with `-` is passed as `./<path>` so Blender's or the export script's argument parser never reads it as a flag.
- Failures throw `BlenderBridgeError` with a stable `code`:
  - `blender.invalidOption`: a bad export option or a non-string `blenderExecutable` / `pythonScript` recipe setting, or one that is set while the importer was not constructed with `allowRecipeExecutableOverrides: true` (recipes are project data and may not choose which program runs; checked before anything is spawned).
  - `blender.spawnFailed`: the Blender executable could not be started.
  - `blender.exportFailed`: Blender exited non-zero; the message keeps the `Blender export failed with code N` prefix and quotes at most the last 4,000 characters of stderr.
  - `blender.outputMissing`: Blender exited 0 but neither `<target>` nor `<target>.glb` exists.
- `NodeProcessRunner` resolves on `close` (after stdout/stderr are drained), reports the terminating signal, and keeps at most the last 1,000,000 characters per stream.
- The export manifest is optional. A present but malformed manifest, or fields of the wrong type, become `warning` diagnostics (`blender.manifestInvalid`, `blender.manifestFieldInvalid`) on the import result instead of being dropped silently.
