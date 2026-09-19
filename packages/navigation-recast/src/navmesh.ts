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
  readyPromise ??= init();
  await readyPromise;
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
