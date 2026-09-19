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
}

export interface CharacterBodyComponent {
  speed?: number;
  offset?: number;
  autostepMaxHeight?: number;
  autostepMinWidth?: number;
}
