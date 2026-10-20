# Marker

A second game module for the Electron player (`runtime.start { game: "marker" }`).

The module registers one script, `MarkerPulse`, which counts `onUpdate` calls. `readGameState` returns `{ pulses, fingerprint }`. `fingerprint` is `hashBytes` from `@kinetra/asset-pipeline/pure` of the UTF-8 string `kinetra-marker`, so the player bundle of this module is also a bundle of that browser-safe entry.

Arena stays the default. A start that omits `game` does not register `MarkerPulse`.
