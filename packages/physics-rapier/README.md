# @kinetra/physics-rapier

Rapier adapter with Kinetra-owned IDs/contracts.

Current proof:
- fixed timestep accumulator
- fixed/dynamic bodies and colliders
- kinematic capsule + Rapier character controller
- library-neutral state snapshots
- runtime stats/resource teardown

The project model should reference Kinetra physics semantics; Rapier handles stay inside this package.
