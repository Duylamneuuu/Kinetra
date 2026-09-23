# @kinetra/player

Development player shell and basis for packaged game builds.

## P1 spike

This app deliberately proves the desktop pipeline before the full engine UI exists:

- Vite bundles the browser-compatible game renderer.
- Electron provides a pinned Chromium runtime.
- preload/main IPC exposes only a narrow fullscreen + user-data-path bridge.
- `@electron/packager` creates a standalone Windows application directory and a portable Linux x64 folder.
- Windows CI launches the packaged `KinetraGame.exe --smoke-test` and requires a clean exit after the real renderer page loads.
- Linux CI launches the packaged `KinetraGame` binary and proves the same runtime bridge against that executable. Linux dev Electron is a different proof.

The temporary spinning-cube scene is **packaging smoke content, not the authoring architecture**. Game state remains destined to come from Kinetra's project/command/runtime layers.

### Commands

~~~bash
pnpm --filter @kinetra/player build
pnpm --filter @kinetra/player package:win
pnpm --filter @kinetra/player smoke:win
pnpm --filter @kinetra/player package:linux
pnpm --filter @kinetra/player smoke:linux:packaged
~~~

## Linux cloud smoke

`smoke:linux` is fast real-Electron development/runtime proof on Linux. It
builds nothing itself; build first, then run one command:

~~~bash
pnpm build
pnpm --filter @kinetra/player smoke:linux
~~~

What it does:

- launches the real Electron player under `xvfb` (auto re-exec when no
  `DISPLAY` is set) with Linux-only software-rendering switches;
- connects through the existing cross-platform stdio runtime bridge
  (`transport: "stdio"` in `@kinetra/verification`, no new protocol);
- drives the real Kinetra Arena reference game: `ping`, `runtime.hostInfo`
  (must report `linux`), `runtime.start`, `runtime.query`, `runtime.step`,
  `runtime.injectInput` (asserts the player actually moves), real PNG frame
  capture (magic bytes + size validated), structured log observation, and
  `runtime.stop`;
- repeats the run and asserts no leaked Electron processes via a `/proc` scan;
- writes frames + machine-readable `report.json` to
  `apps/player/dist/linux-smoke/` (uploaded as a CI artifact).

Verification hierarchy (unchanged):

- Linux smoke = real-Electron development/runtime proof.
- Windows CI (`smoke:win`) = native Windows package/platform proof.
- `KinetraGame.exe` acceptance = packaged Windows proof.

Linux proof is never claimed as Windows proof. The bridge window is shown
under xvfb (`KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW=1`) because hidden windows
yield DOM-stale `capturePage()` frames; Windows defaults are untouched.
