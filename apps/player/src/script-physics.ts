// Script-facing physics queries. The world is read lazily: scene start creates it after the
// script object exists, and a later stop clears it. No Rapier value import, so this stays out
// of the WASM chunk.

import type { GameScriptPhysicsService } from "@kinetra/core";
import type { PhysicsHit, RaycastQuery, ShapeCastQuery } from "@kinetra/physics-rapier";

export const PHYSICS_WORLD_UNAVAILABLE = "Physics world is not available";

export interface ScriptPhysicsWorld {
  raycast(query: RaycastQuery): PhysicsHit | null;
  shapeCast(query: ShapeCastQuery): PhysicsHit | null;
}

export function createScriptPhysicsService(
  getWorld: () => ScriptPhysicsWorld | undefined,
): GameScriptPhysicsService {
  const world = (): ScriptPhysicsWorld => {
    const current = getWorld();
    if (!current) {
      throw new Error(PHYSICS_WORLD_UNAVAILABLE);
    }
    return current;
  };
  return {
    raycast: (query) => world().raycast(query),
    shapeCast: (query) => world().shapeCast(query),
  };
}
