# @kinetra/blender-bridge

Thin headless/Python automation boundary for Blender inspection, export and eventually structured model/rig/animation operations.

## Error and input contract

- `blenderHeadlessArgs` is pure and deterministic. Every path option must be a non-empty string without NUL characters; a relative path starting with `-` is passed as `./<path>` so Blender's or the export script's argument parser never reads it as a flag.
- Failures throw `BlenderBridgeError` with a stable `code`:
  - `blender.invalidOption`: a bad export option or a non-string `blenderExecutable` / `pythonScript` recipe setting (checked before Blender is spawned).
  - `blender.spawnFailed`: the Blender executable could not be started.
  - `blender.exportFailed`: Blender exited non-zero; the message keeps the `Blender export failed with code N` prefix and quotes at most the last 4,000 characters of stderr.
  - `blender.outputMissing`: Blender exited 0 but neither `<target>` nor `<target>.glb` exists.
- `NodeProcessRunner` resolves on `close` (after stdout/stderr are drained), reports the terminating signal, and keeps at most the last 1,000,000 characters per stream.
- The export manifest is optional. A present but malformed manifest, or fields of the wrong type, become `warning` diagnostics (`blender.manifestInvalid`, `blender.manifestFieldInvalid`) on the import result instead of being dropped silently.

## Public API

| Export | Role |
| --- | --- |
| `blenderHeadlessArgs(options)` | pure argv for `blender --background <blend> --python <script> -- --output <glb>` |
| `runBlenderExport(options, runner?)` | runs the export through a `ProcessRunner` and throws `BlenderBridgeError` on failure |
| `NodeProcessRunner({ maxOutputChars?, timeoutMs? })` | default runner; kills the whole process group after `timeoutMs` (default `DEFAULT_BLENDER_TIMEOUT_MS`, 5 minutes) and reports `timedOut` |
| `BlenderBridgeError` | stable `code` (`blender.invalidOption`, `blender.spawnFailed`, `blender.exportFailed`, `blender.timeout`, `blender.outputMissing`) plus `details` |
| `BlenderGlbImporter` and friends | engine-owned importer that turns a `.blend` into a validated GLB (see `src/importer.ts`) |

Proof level: Node unit tests with fake runners (`test/blender-bridge.test.ts`, `test/importer.test.ts`, `test/hardening.test.ts`); the real headless Blender export, modification and reimport runs in `.github/workflows/blender-pipeline.yml`.

## Example

Runs without Blender by injecting a `ProcessRunner`; this example is executed by `pnpm check:docs`.

```ts doc-check
import assert from "node:assert/strict";
import {
  BlenderBridgeError,
  blenderHeadlessArgs,
  runBlenderExport,
  type ProcessRunner,
} from "@kinetra/blender-bridge";

const options = {
  blenderExecutable: "blender",
  sourceBlend: "-hero.blend", // a leading "-" is passed as "./-hero.blend", never read as a flag
  outputGlb: "out/hero.glb",
  pythonScript: "export_glb.py",
};
assert.deepEqual(blenderHeadlessArgs(options), [
  "--background", "./-hero.blend", "--python", "export_glb.py", "--", "--output", "out/hero.glb",
]);

const ok: ProcessRunner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
await runBlenderExport(options, ok);

const crashed: ProcessRunner = { run: async () => ({ code: 2, stdout: "", stderr: "boom" }) };
await assert.rejects(runBlenderExport(options, crashed), (error: unknown) => {
  assert.ok(error instanceof BlenderBridgeError);
  assert.equal(error.code, "blender.exportFailed");
  return true;
});

const hung: ProcessRunner = { run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true, signal: "SIGKILL" }) };
await assert.rejects(runBlenderExport(options, hung), (error: unknown) => {
  assert.ok(error instanceof BlenderBridgeError);
  assert.equal(error.code, "blender.timeout");
  return true;
});
```
