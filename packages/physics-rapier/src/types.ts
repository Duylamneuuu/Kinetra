export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface BodyState {
  id: string;
  position: Vec3;
  rotation: Quaternion;
  linearVelocity: Vec3;
}

export interface CharacterMoveResult {
  requested: Vec3;
  actual: Vec3;
  collided: boolean;
}

export interface PhysicsStats {
  bodies: number;
  colliders: number;
  fixedSteps: number;
  accumulatorSeconds: number;
}

export type RigidBodyType =
  | "fixed"
  | "static"
  | "dynamic"
  | "kinematic"
  | "kinematicPositionBased"
  | "kinematicVelocityBased";

export interface RigidBodyComponent {
  type?: RigidBodyType;
  mass?: number;
  gravityScale?: number;
  linearDamping?: number;
  angularDamping?: number;
}

export type ColliderShape =
  | "box"
  | "cuboid"
  | "sphere"
  | "ball"
  | "capsule"
  | "plane";

export interface ColliderComponent {
  shape?: ColliderShape;
  size?: [number, number, number];
  halfExtents?: [number, number, number];
  radius?: number;
  halfHeight?: number;
  restitution?: number;
  friction?: number;
  /** Query-filter layer 0..31 used by raycast / shapeCast (default 0). */
  layer?: number;
}

export interface CharacterBodyComponent {
  speed?: number;
  offset?: number;
  autostepMaxHeight?: number;
  autostepMinWidth?: number;
}

/** Highest collision layer index usable for query filtering (layers 0..31). */
export const MAX_PHYSICS_LAYER = 31;

/**
 * Options shared by `raycast` and `shapeCast`. Layers are the query-filter layers assigned to
 * colliders (`layer` on the Collider component, default 0).
 */
export interface PhysicsQueryFilter {
  /**
   * Only hit colliders on one of these layers. `undefined` means every layer; an empty array
   * means no layer, so the query never hits anything.
   */
  layers?: readonly number[];
  /** Entity ids that the query must ignore (for example the caster itself). */
  excludeEntityIds?: readonly string[];
  /** Maximum distance travelled, in world units. Finite and > 0; defaults to 1000. */
  maxDistance?: number;
}

export interface RaycastQuery extends PhysicsQueryFilter {
  origin: Vec3;
  /** Any non-zero finite vector; it is normalized internally. */
  direction: Vec3;
}

export type ShapeCastShape =
  | { type: "sphere"; radius: number }
  | { type: "box"; halfExtents: Vec3 }
  | { type: "capsule"; halfHeight: number; radius: number };

export interface ShapeCastQuery extends PhysicsQueryFilter {
  shape: ShapeCastShape;
  origin: Vec3;
  direction: Vec3;
  /** Orientation of the cast shape; defaults to identity. */
  rotation?: Quaternion;
}

/**
 * Kinetra-owned query result: no Rapier handles or objects leak through it.
 * `distance` is the distance travelled along the (normalized) direction until contact.
 * `startedInside` is true when the ray origin / cast shape already overlapped the hit entity
 * (distance 0); in that case `normal` is the reverse of the cast direction.
 */
export interface PhysicsHit {
  entityId: string;
  point: Vec3;
  normal: Vec3;
  distance: number;
  startedInside: boolean;
}
