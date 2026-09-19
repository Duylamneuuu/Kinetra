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

## Packaged-build truth

For shipping tasks, the final smoke suite launches the packaged executable. Passing \`npm run dev\` is not enough.

## Determinism

Pin the Electron/runtime environment used for visual baselines. Rendering screenshots can vary across OS/GPU/browser versions, so semantic assertions remain authoritative where possible.
