// Copies a physics body state onto its render object. Extracted from the player runtime
// controller so the rule can be tested under plain Node with fake objects.
//
// A kinematic character body is position-driven only: Rapier never rotates it, so its physics
// rotation is always the identity. Its facing is owned by the render object (root-motion yaw,
// scripts). Writing the body's identity quaternion back every step erased that facing in the same
// step it was applied, so root motion reported an `appliedYaw` that never showed up on screen and
// the next frame sampled yaw 0 again.

export interface PhysicsSyncTarget {
  readonly position: { set(x: number, y: number, z: number): unknown };
  readonly quaternion: { set(x: number, y: number, z: number, w: number): unknown };
}

export interface PhysicsSyncState {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
}

export interface PhysicsSyncOptions {
  /** True for bodies whose rotation physics does not own (kinematic characters). */
  readonly preserveRotation: boolean;
}

export function applyPhysicsStateToObject(
  object: PhysicsSyncTarget,
  state: PhysicsSyncState,
  options: PhysicsSyncOptions,
): void {
  object.position.set(state.position.x, state.position.y, state.position.z);
  if (options.preserveRotation) return;
  object.quaternion.set(
    state.rotation.x,
    state.rotation.y,
    state.rotation.z,
    state.rotation.w,
  );
}
