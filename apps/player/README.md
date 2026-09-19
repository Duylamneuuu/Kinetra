# @kinetra/player

Development player shell and basis for packaged game builds.

## P1 spike

This app deliberately proves the desktop pipeline before the full engine UI exists:

- Vite bundles the browser-compatible game renderer.
- Electron provides a pinned Chromium runtime.
- preload/main IPC exposes only a narrow fullscreen + user-data-path bridge.
- `@electron/packager` creates a standalone Windows application directory.
- Windows CI launches the packaged `KinetraGame.exe --smoke-test` and requires a clean exit after the real renderer page loads.

The temporary spinning-cube scene is **packaging smoke content, not the authoring architecture**. Game state remains destined to come from Kinetra's project/command/runtime layers.

### Commands

~~~bash
pnpm --filter @kinetra/player build
pnpm --filter @kinetra/player package:win
pnpm --filter @kinetra/player smoke:win
~~~
