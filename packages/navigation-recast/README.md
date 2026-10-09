# @kinetra/navigation-recast

Offline-first Recast navmesh generation plus Detour path/crowd runtime integration.

Bake a navigation mesh from plain triangle data, query paths and closest points, and round-trip the baked mesh through bytes so a project can ship a pre-baked navmesh instead of rebuilding it at runtime. WASM (`@recast-navigation/core`) is initialized lazily; a failed init is retryable.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `RecastNavMesh.bake(input)` | static, async | Bakes a solo navmesh from `NavMeshBakeInput` (`positions`, `indices`, optional `cellSize`, `cellHeight`, `agentHeight`, `agentRadius`, `agentMaxClimb`, `agentMaxSlope` in degrees). Malformed geometry or non-finite/non-positive parameters throw `RangeError` before reaching WASM. |
| `RecastNavMesh.fromBytes(bytes)` / `nav.toBytes()` | static / method | Import / export the baked mesh (offline bake, runtime load). |
| `nav.computePath(start, end, params?)` | method | Returns a `PathResult`: `points`, `success`, and `status` of `"complete"`, `"partial"` (walkable waypoints that stop at the closest reachable point because the goal is on a disconnected region) or `"failed"`. Only `"complete"` has `success: true`. |
| `nav.closestPoint(position, params?)` | method | Nearest point on the navmesh; throws when none lies within `halfExtents`. |
| `nav.dispose()` / `nav.disposed` | method / getter | Frees WASM memory; idempotent. Any query after dispose throws. |
| `initNavigation()` | function | Optional eager WASM init (called automatically by `bake`/`fromBytes`). |
| `DEFAULT_QUERY_HALF_EXTENTS` | const | `{ x: 2, y: 4, z: 2 }`, the search box used when `params.halfExtents` is omitted. |

## Example

```ts doc-check
import assert from "node:assert/strict";
import { RecastNavMesh } from "@kinetra/navigation-recast";

// A flat 10 x 10 ground quad (two triangles, counter-clockwise seen from above).
const positions = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5];
const indices = [0, 2, 1, 0, 3, 2];

const nav = await RecastNavMesh.bake({ positions, indices });
try {
  const path = nav.computePath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 });
  assert.equal(path.status, "complete");
  assert.equal(path.success, true);
  assert.ok(path.points.length >= 2);

  // Ship the bake: bytes in, same mesh out.
  const reloaded = await RecastNavMesh.fromBytes(nav.toBytes());
  try {
    const again = reloaded.computePath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 });
    assert.equal(again.status, "complete");
  } finally {
    reloaded.dispose();
  }

  // Bad input fails loudly and early.
  await assert.rejects(
    () => RecastNavMesh.bake({ positions, indices, cellSize: -1 }),
    /NavMesh bake parameter/,
  );
} finally {
  nav.dispose();
}
assert.equal(nav.disposed, true);
assert.throws(() => nav.toBytes(), /disposed/);
```

## Proof level

`test/navigation.test.ts` (package `test` script) covers bake, path, serialization round trip, idempotent disposal, partial paths to unreachable islands, and bake-input validation. Scripts reach navigation through the `context.navigation` service (`GameScriptNavigationService` in `@kinetra/core`); see [`docs/STATUS.md`](../../docs/STATUS.md) for the project-wide proof table.
