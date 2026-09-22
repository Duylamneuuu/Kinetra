# Verification platform

Verification is a first-class engine system, not final polish.

## Why

AI systems frequently stop at "build succeeds" or "screenshot looks good". Kinetra must require behavioral proof.

## Acceptance manifest

A shipping suite should eventually express requirements like:

~~~json
{
  "suite": "shipping",
  "requirements": [
    { "test": "game.boots" },
    { "test": "mainMenu.visible" },
    { "test": "newGame.starts" },
    { "test": "player.canMove" },
    { "test": "pause.works" },
    { "test": "settings.persist" },
    { "test": "saveLoad.roundTrip" },
    { "test": "winCondition.reachable" },
    { "test": "loseCondition.reachable" },
    { "test": "runtime.noFatalErrors" },
    { "test": "assets.noMissingReferences" },
    { "test": "packagedExe.boots" }
  ]
}
~~~

Genre-specific suites add gameplay assertions.

## Player bot

Tests operate through named game actions, not only physical keys.

~~~text
runtime.start(seed)
input.hold("move.forward", 2000)
assert player.position changed
input.press("jump")
assert grounded becomes false
...
~~~

## Three evidence types

Use together:

1. **structured state** for correctness;
2. **logs/metrics** for failures/performance;
3. **screenshots/vision** for visual defects.

Vision should not be asked to infer save-slot correctness when structured state can answer it.

## Platform proof hierarchy

These proofs are not interchangeable:

| Command / target | What it proves |
|---|---|
| `pnpm --filter @kinetra/player smoke:linux` | Linux dev Electron, under xvfb when `DISPLAY` is unset, using software rendering. Speaks the existing stdio runtime bridge (`KINETRA_RUNTIME_BRIDGE_STDIO=1` / `--runtime-bridge-stdio`). |
| Windows GitHub Actions `package:win` + `smoke:win` | Native Windows package and platform behavior. |
| Packaged `KinetraGame.exe` acceptance | Shipped Windows executable. |

`smoke:linux` builds the real player, launches real Electron, and drives Kinetra Arena through `ping`, `runtime.hostInfo`, `runtime.start`, `runtime.query`, `runtime.injectInput`, `runtime.step`, `runtime.captureFrame`, and `runtime.stop`. `runtime.hostInfo.platform` must be `linux`. Semantic `player.moveForward` must change player position and arena controller state. The captured frame must be a real PNG. The command repeats and fails if Electron processes from that session remain.

It does not certify Windows packaging or `KinetraGame.exe`.

## Packaged-build truth

For shipping tasks, the final smoke suite launches the packaged executable. Passing `npm run dev` is not enough.

## Determinism

Pin the Electron/runtime environment used for visual baselines. Rendering screenshots can vary across OS/GPU/browser versions, so semantic assertions remain authoritative where possible.
