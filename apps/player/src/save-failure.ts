/**
 * Structured failure result of PlayerRuntimeController.loadSave. It lives apart from the controller
 * (which needs a WebGL renderer and a DOM) so the result shape can be unit-tested under plain Node.
 *
 * loadSave declares `phase` ("validation" | "migration" | "preparation" | "commit" | "rollback") and
 * `slotId` in its return type and logs both in `save.restoreFailed`. Before this helper only the
 * commit/rollback branches and two validation branches returned them: a malformed envelope, a
 * failed migration, a scene mismatch or a bad entity entry came back as a bare
 * `{ success: false, error }`, so a caller could not tell which phase failed or which slot it was.
 */

export type LoadSaveFailurePhase =
  | "validation"
  | "migration"
  | "preparation"
  | "commit"
  | "rollback";

export interface LoadSaveFailure {
  success: false;
  slotId?: string;
  error: string;
  phase: LoadSaveFailurePhase;
  rolledBack?: boolean;
  atomicityViolation?: boolean;
}

/**
 * Message of the preparation failure returned when stop()/start() replaced the runtime while a
 * loadSave was awaiting (the slot read, a script's prepareRestoreState). The load applied nothing.
 */
export function loadSaveSupersededMessage(): string {
  return "Cannot load save: the runtime was stopped or restarted while the save was loading; nothing was applied";
}

export function loadSaveFailure(
  phase: LoadSaveFailurePhase,
  error: string,
  slotId?: string,
  extra: { rolledBack?: boolean; atomicityViolation?: boolean } = {},
): LoadSaveFailure {
  return {
    success: false,
    ...(slotId !== undefined ? { slotId } : {}),
    error,
    phase,
    ...(extra.rolledBack !== undefined ? { rolledBack: extra.rolledBack } : {}),
    ...(extra.atomicityViolation !== undefined
      ? { atomicityViolation: extra.atomicityViolation }
      : {}),
  };
}
