export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface NavMeshBakeInput {
  positions: number[] | Float32Array;
  indices: number[] | Uint32Array | Uint16Array;
  cellSize?: number;
  cellHeight?: number;
  agentHeight?: number;
  agentRadius?: number;
  agentMaxClimb?: number;
  agentMaxSlope?: number;
}

export interface NavMeshQueryParams {
  halfExtents?: Vec3;
}

export interface PathResult {
  /** Walkable waypoints. For a "partial" result they end at the closest reachable point, not the goal. */
  points: Vec3[];
  /** True only when the path reaches the goal ("complete"). */
  success: boolean;
  status: "complete" | "partial" | "failed";
}
