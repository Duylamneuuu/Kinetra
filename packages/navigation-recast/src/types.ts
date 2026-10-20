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
  /**
   * Bake a tile cache so obstacles can be added and removed without a full rebake.
   * A mesh loaded from bytes is a static snapshot and cannot take obstacles.
   */
  tileCache?: boolean;
  /** Tiles on the xz plane, in voxels. Only with `tileCache`. Default is the Recast tile-cache default (32). */
  tileSize?: number;
  /** Cap on simultaneous obstacles. Only with `tileCache`. Default 128. */
  maxObstacles?: number;
}

export type NavigationErrorCode =
  | "nav.obstaclesUnsupported"
  | "nav.obstacle.invalid"
  | "nav.obstacle.unknown"
  | "nav.obstacle.failed";

/** A navigation failure an agent can branch on. The message starts with `[code]` and ends with `remediation`. */
export class NavigationError extends Error {
  readonly code: NavigationErrorCode;
  readonly remediation: string;

  constructor(code: NavigationErrorCode, message: string, remediation: string) {
    super(`[${code}] ${message} ${remediation}`);
    this.name = "NavigationError";
    this.code = code;
    this.remediation = remediation;
  }
}

export interface CylinderObstacleInput {
  type: "cylinder";
  /** Bottom centre of the cylinder, in world units. */
  position: Vec3;
  radius: number;
  height: number;
}

export interface BoxObstacleInput {
  type: "box";
  /** Centre of the box, in world units. */
  position: Vec3;
  halfExtents: Vec3;
  /** Yaw in radians. */
  angle: number;
}

export type NavObstacleInput = CylinderObstacleInput | BoxObstacleInput;

export type NavObstacle = NavObstacleInput & { readonly id: string };

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
