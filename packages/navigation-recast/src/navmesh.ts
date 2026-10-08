import {
  NavMeshQuery,
  exportNavMesh,
  importNavMesh,
  init,
  type NavMesh,
} from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";

import type {
  NavMeshBakeInput,
  NavMeshQueryParams,
  PathResult,
  Vec3,
} from "./types.js";

let readyPromise: Promise<void> | undefined;

export async function initNavigation(): Promise<void> {
  readyPromise ??= init().catch((error: unknown) => {
    // Do not cache a rejected init forever: a transient WASM load failure must be retryable.
    readyPromise = undefined;
    throw error;
  });
  await readyPromise;
}

/**
 * Horizontal (XZ) distance in world units under which the last path waypoint counts as
 * reaching the goal. Height is ignored on purpose: Detour reports the polygon-query point
 * with detail-mesh height while straight-path endpoints keep the requested height.
 */
const PATH_END_TOLERANCE = 1e-2;

function assertPositiveFinite(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`NavMesh bake parameter "${name}" must be a finite number > 0, got ${String(value)}`);
  }
}

function assertNonNegativeFinite(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`NavMesh bake parameter "${name}" must be a finite number >= 0, got ${String(value)}`);
  }
}

function validateBakeInput(input: NavMeshBakeInput, positions: number[], indices: number[]): void {
  assertPositiveFinite("cellSize", input.cellSize);
  assertPositiveFinite("cellHeight", input.cellHeight);
  assertPositiveFinite("agentHeight", input.agentHeight);
  assertNonNegativeFinite("agentRadius", input.agentRadius);
  assertNonNegativeFinite("agentMaxClimb", input.agentMaxClimb);
  if (input.agentMaxSlope !== undefined) {
    const slope = input.agentMaxSlope;
    if (typeof slope !== "number" || !Number.isFinite(slope) || slope < 0 || slope >= 90) {
      throw new RangeError(`NavMesh bake parameter "agentMaxSlope" must be a finite angle in degrees within [0, 90), got ${String(slope)}`);
    }
  }
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new RangeError(`NavMesh bake input "positions" length must be a positive multiple of 3, got ${positions.length}`);
  }
  if (!positions.every((value) => Number.isFinite(value))) {
    throw new RangeError('NavMesh bake input "positions" must contain only finite numbers');
  }
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new RangeError(`NavMesh bake input "indices" length must be a positive multiple of 3, got ${indices.length}`);
  }
  const vertexCount = positions.length / 3;
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      throw new RangeError(`NavMesh bake input "indices" contains out-of-range vertex index ${String(index)} (vertex count ${vertexCount})`);
    }
  }
}

export const DEFAULT_QUERY_HALF_EXTENTS: Vec3 = { x: 2, y: 4, z: 2 };

export class RecastNavMesh {
  #query: NavMeshQuery;
  #navMesh: NavMesh;
  #disposed = false;

  private constructor(navMesh: NavMesh) {
    this.#navMesh = navMesh;
    this.#query = new NavMeshQuery(navMesh);
  }

  static async bake(input: NavMeshBakeInput): Promise<RecastNavMesh> {
    await initNavigation();

    const positions = Array.isArray(input.positions)
      ? input.positions
      : Array.from(input.positions);
    const indices = Array.isArray(input.indices)
      ? input.indices
      : Array.from(input.indices);
    validateBakeInput(input, positions, indices);

    const config: Record<string, unknown> = {};
    if (input.cellSize !== undefined) config.cs = input.cellSize;
    if (input.cellHeight !== undefined) config.ch = input.cellHeight;
    if (input.agentHeight !== undefined)
      config.walkableHeight = Math.ceil(
        input.agentHeight / (input.cellHeight ?? 0.2),
      );
    if (input.agentRadius !== undefined)
      config.walkableRadius = Math.ceil(
        input.agentRadius / (input.cellSize ?? 0.2),
      );
    if (input.agentMaxClimb !== undefined)
      config.walkableClimb = Math.floor(
        input.agentMaxClimb / (input.cellHeight ?? 0.2),
      );
    if (input.agentMaxSlope !== undefined)
      config.walkableSlopeAngle = input.agentMaxSlope;

    const result = generateSoloNavMesh(positions, indices, config);
    if (!result.success) {
      throw new Error(`NavMesh bake failed: ${result.error}`);
    }

    return new RecastNavMesh(result.navMesh);
  }

  static async fromBytes(bytes: Uint8Array): Promise<RecastNavMesh> {
    await initNavigation();
    const imported = importNavMesh(bytes);
    if (!imported.navMesh) {
      throw new Error("Failed to import NavMesh from binary bytes");
    }
    return new RecastNavMesh(imported.navMesh);
  }

  toBytes(): Uint8Array {
    this.#assertNotDisposed();
    return exportNavMesh(this.#navMesh);
  }

  closestPoint(position: Vec3, params: NavMeshQueryParams = {}): Vec3 {
    this.#assertNotDisposed();
    const halfExtents = params.halfExtents ?? DEFAULT_QUERY_HALF_EXTENTS;
    const result = this.#query.findClosestPoint(position, { halfExtents });
    if (!result.success) {
      throw new Error(
        `No closest point found on NavMesh for position (${position.x}, ${position.y}, ${position.z}) within extents (${halfExtents.x}, ${halfExtents.y}, ${halfExtents.z})`,
      );
    }
    return { x: result.point.x, y: result.point.y, z: result.point.z };
  }

  computePath(
    start: Vec3,
    end: Vec3,
    params: NavMeshQueryParams = {},
  ): PathResult {
    this.#assertNotDisposed();
    const halfExtents = params.halfExtents ?? DEFAULT_QUERY_HALF_EXTENTS;
    const result = this.#query.computePath(start, end, { halfExtents });
    if (!result.success || result.path.length === 0) {
      return {
        points: [],
        success: false,
        status: "failed",
      };
    }

    const points: Vec3[] = result.path.map((pt: { x: number; y: number; z: number }) => ({
      x: pt.x,
      y: pt.y,
      z: pt.z,
    }));

    // Detour returns success with a path to the closest reachable polygon when the goal
    // lies on a disconnected region. Report that truthfully as a partial path: the
    // waypoints are walkable, but they do not reach the requested goal.
    const goal = this.#query.findClosestPoint(end, { halfExtents });
    const last = points[points.length - 1]!;
    if (goal.success) {
      const dx = last.x - goal.point.x;
      const dz = last.z - goal.point.z;
      if (Math.hypot(dx, dz) > PATH_END_TOLERANCE) {
        return { points, success: false, status: "partial" };
      }
    }

    return {
      points,
      success: true,
      status: "complete",
    };
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#query.destroy();
    this.#navMesh.destroy();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("RecastNavMesh instance has already been disposed");
    }
  }
}
