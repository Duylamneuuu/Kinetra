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

Verification hierarchy:

- `smoke:linux` = Linux x64 dev Electron proof under xvfb. CI: `.github/workflows/linux-player.yml` on pull requests (green on PR #48 and again on PR #49 and PR #50).
- `package:linux` + `smoke:linux:packaged` = Linux x64 packaged `KinetraGame` proof, including Arena semantic input, combat, gameplay loop, desktop save/load, and process teardown. CI: `.github/workflows/linux-packaged-player.yml` (green on PR #50 and PR #49).
- `xvfb-run -a pnpm --filter @kinetra/verification test` = the dev Electron acceptance suite, including combat and save/load. CI: `.github/workflows/linux-verification.yml` (green on PR #49, job `real-electron-tests`).
- Windows CI (`smoke:win`) and `KinetraGame.exe` acceptance remain the Windows package proof. A green Linux run is not Windows proof.

Not in this milestone: ARM64, AppImage, Flatpak, Snap, deb/rpm, Wayland-specific certification, Steam, signing, an installer, or auto-update.

Linux proof is never claimed as Windows proof. The bridge window is shown
under xvfb (`KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW=1`) because hidden windows
yield DOM-stale `capturePage()` frames; Windows defaults are untouched.
