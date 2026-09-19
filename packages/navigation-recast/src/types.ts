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
  points: Vec3[];
  success: boolean;
  status: "complete" | "partial" | "failed";
}
