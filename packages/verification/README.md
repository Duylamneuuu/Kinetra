# @kinetra/verification

The completion gate for AI-authored games.

A task is not complete because code compiled or a screenshot looked plausible. Acceptance manifests drive semantic input and verify structured state, logs, screenshots, metrics, and eventually packaged executables.

Current core includes:
- deterministic seed in manifest
- semantic player actions
- state equality/near assertions
- fatal/warning log absence
- metric min/max budgets
- exact screenshot SHA-256 regression primitive
- machine-readable early-failure reports
- generic packaged-process smoke runner
- dev Electron acceptance on Windows, and on Linux when `DISPLAY` is set or `KINETRA_LINUX_REAL_ELECTRON=1` (xvfb). Linux launches use software GL unless `KINETRA_LINUX_GL=hardware`. Packaged `KinetraGame.exe` tests stay Windows-only.

Perceptual image comparison and AI visual critique remain adapters layered on this deterministic base.
