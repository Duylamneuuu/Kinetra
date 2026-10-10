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

/** Accept plain arrays and typed arrays only; anything else is a structured RangeError, not a raw TypeError. */
function toNumberArray(name: string, value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  throw new RangeError(`NavMesh bake input "${name}" must be an array or typed array of numbers, got ${value === null ? "null" : typeof value}`);
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
  // A plain loop, not Array.prototype.every: every() skips the holes of a sparse array,
  // so `[0, , 0, ...]` used to pass validation and reach Recast as undefined/NaN.
  for (let i = 0; i < positions.length; i += 1) {
    if (typeof positions[i] !== "number" || !Number.isFinite(positions[i])) {
      throw new RangeError('NavMesh bake input "positions" must contain only finite numbers');
    }
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

function assertFiniteVec3(name: string, value: Vec3): void {
  if (
    typeof value !== "object" || value === null ||
    typeof value.x !== "number" || typeof value.y !== "number" || typeof value.z !== "number" ||
    !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)
  ) {
    throw new RangeError(`NavMesh query "${name}" must be a Vec3 of finite numbers, got ${JSON.stringify(value)}`);
  }
}

function resolveHalfExtents(params: NavMeshQueryParams | undefined): Vec3 {
  const halfExtents = params?.halfExtents ?? DEFAULT_QUERY_HALF_EXTENTS;
  assertFiniteVec3("halfExtents", halfExtents);
  if (halfExtents.x <= 0 || halfExtents.y <= 0 || halfExtents.z <= 0) {
    throw new RangeError(`NavMesh query "halfExtents" components must be > 0, got ${JSON.stringify(halfExtents)}`);
  }
  return halfExtents;
}

/** 'MSET' as written by exportNavMesh (little-endian int32), followed by version 1. */
const NAVMESH_SET_MAGIC = 0x4d534554;
const NAVMESH_SET_VERSION = 1;
/** int32 magic, int32 version, int32 numTiles, then dtNavMeshParams (7 x 4 bytes). */
const NAVMESH_SET_HEADER_BYTES = 40;
/** Per tile: uint32 tileRef, int32 dataSize, then dataSize bytes. */
const NAVMESH_TILE_HEADER_BYTES = 8;

/**
 * Detour does not reject garbage: importing it yields a mesh that traps ("memory access out of
 * bounds") on destroy or hangs on query. Check the exported container structure up front so
 * callers get a structured error before any WASM call.
 */
function assertNavMeshBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new RangeError("NavMesh bytes must be a non-empty Uint8Array");
  }
  const fail = (reason: string): never => {
    throw new RangeError(`Failed to import NavMesh from binary bytes: ${reason}`);
  };
  if (bytes.byteLength < NAVMESH_SET_HEADER_BYTES) fail(`${bytes.byteLength} bytes is shorter than the ${NAVMESH_SET_HEADER_BYTES}-byte header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== NAVMESH_SET_MAGIC) fail("not a navmesh export (bad magic)");
  if (view.getInt32(4, true) !== NAVMESH_SET_VERSION) fail(`unsupported navmesh export version ${view.getInt32(4, true)}`);
  const numTiles = view.getInt32(8, true);
  if (numTiles < 1 || numTiles > (bytes.byteLength - NAVMESH_SET_HEADER_BYTES) / NAVMESH_TILE_HEADER_BYTES) {
    fail(`invalid tile count ${numTiles}`);
  }
  let offset = NAVMESH_SET_HEADER_BYTES;
  for (let tile = 0; tile < numTiles; tile += 1) {
    if (offset + NAVMESH_TILE_HEADER_BYTES > bytes.byteLength) fail(`truncated before tile ${tile}`);
    const dataSize = view.getInt32(offset + 4, true);
    offset += NAVMESH_TILE_HEADER_BYTES;
    if (dataSize <= 0 || offset + dataSize > bytes.byteLength) fail(`tile ${tile} data size ${dataSize} exceeds the available bytes`);
    offset += dataSize;
  }
  if (offset !== bytes.byteLength) fail(`${bytes.byteLength - offset} unexpected trailing bytes`);
}

/**
 * Converts a world-space length to a whole number of voxel cells. `0.6 / 0.2` is
 * 2.9999999999999996 in floating point, so a bare `Math.floor` loses a whole cell
 * (a 0.6 step with cellHeight 0.2 would count as 2 cells of climb) and a bare
 * `Math.ceil` of `1.05 / 0.15` (7.000000000000001) gains one. Quotients within a
 * relative 1e-9 of an integer snap to it first.
 */
function toCells(length: number, cell: number, round: (value: number) => number): number {
  const quotient = length / cell;
  const nearest = Math.round(quotient);
  return round(Math.abs(quotient - nearest) <= 1e-9 * Math.max(1, Math.abs(nearest)) ? nearest : quotient);
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

    if (typeof input !== "object" || input === null) {
      throw new RangeError("NavMesh bake input must be an object with positions and indices");
    }
    const positions = toNumberArray("positions", input.positions);
    const indices = toNumberArray("indices", input.indices);
    validateBakeInput(input, positions, indices);

    const config: Record<string, unknown> = {};
    if (input.cellSize !== undefined) config.cs = input.cellSize;
    if (input.cellHeight !== undefined) config.ch = input.cellHeight;
    if (input.agentHeight !== undefined)
      config.walkableHeight = toCells(input.agentHeight, input.cellHeight ?? 0.2, Math.ceil);
    if (input.agentRadius !== undefined)
      config.walkableRadius = toCells(input.agentRadius, input.cellSize ?? 0.2, Math.ceil);
    if (input.agentMaxClimb !== undefined)
      config.walkableClimb = toCells(input.agentMaxClimb, input.cellHeight ?? 0.2, Math.floor);
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
    assertNavMeshBytes(bytes);
    let imported: ReturnType<typeof importNavMesh>;
    try {
      imported = importNavMesh(bytes);
    } catch (error) {
      throw new Error(`Failed to import NavMesh from binary bytes: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    assertFiniteVec3("position", position);
    const halfExtents = resolveHalfExtents(params);
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
    assertFiniteVec3("start", start);
    assertFiniteVec3("end", end);
    const halfExtents = resolveHalfExtents(params);
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
