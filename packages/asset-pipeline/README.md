# @kinetra/asset-pipeline

Deterministic asset identity, import recipes, hashes/cache keys, dependency invalidation and structured validation.

This package intentionally does **not** require Blender to run its unit tests. Blender execution is isolated behind `@kinetra/blender-bridge`; CI can verify the deterministic pipeline core before a DCC environment is attached.
