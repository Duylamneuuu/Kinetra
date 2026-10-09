# @kinetra/physics-rapier

Rapier integration, collision layers, fixed-step physics and authoritative character motor.

## Spatial queries

`RapierPhysicsWorld` exposes engine-owned queries. Results are plain `PhysicsHit` structs with
no Rapier handles, so they are safe to serialize over the runtime bridge.

```ts
import { RapierPhysicsWorld } from "@kinetra/physics-rapier";

const physics = await RapierPhysicsWorld.create();
physics.addFixedBox({
  id: "floor",
  position: { x: 0, y: -0.5, z: 0 },
  halfExtents: { x: 10, y: 0.5, z: 10 },
  layer: 1,
});

const ray = physics.raycast({
  origin: { x: 2, y: 5, z: 2 },
  direction: { x: 0, y: -1, z: 0 },
  layers: [1],
  excludeEntityIds: ["player"],
  maxDistance: 20,
});
// ray?.entityId === "floor", ray?.distance ~ 5, ray?.normal ~ { x: 0, y: 1, z: 0 }

const sweep = physics.shapeCast({
  shape: { type: "sphere", radius: 0.5 },
  origin: { x: 2, y: 5, z: 2 },
  direction: { x: 0, y: -1, z: 0 },
});
// sweep?.distance ~ 4.5
if (!ray || !sweep) throw new Error("expected both queries to hit the floor");
physics.dispose();
```

Rules:

- `layers` filters by the query layer (`layer` on `Collider`, integer 0..31, default 0).
  `undefined` means every layer; `[]` means none. The layer does **not** change which bodies
  collide in the simulation.
- Queries are read-only and deterministic. Rapier only refreshes its broad phase inside a step,
  so a stale world is refreshed with a zero-timestep step that does not integrate bodies or
  change `stats().fixedSteps`.
- Bad input (zero or non-finite direction, non-positive `maxDistance`, invalid layer, bad shape
  or rotation) throws `RangeError`.
- `startedInside` is true when the origin already overlaps a collider; `distance` is then 0 and
  `normal` is the reverse of the cast direction.
- Not proven yet: script/bridge exposure and a real-Electron test.
