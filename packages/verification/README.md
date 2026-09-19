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

Perceptual image comparison and AI visual critique remain adapters layered on this deterministic base.
