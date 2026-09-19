# @kinetra/animation

AI-readable animation semantics layered above Three.js runtime primitives.

Current core:
- semantic humanoid skeleton profiles
- validation + deterministic skeleton signatures
- retarget pairing and baked-cache keys
- clip metadata/events
- root-motion extraction policies
- text-backed animation graph validation and state-machine evaluation

The package intentionally keeps source-of-truth data independent from a visual graph UI. A future editor graph is another frontend over these structures.
