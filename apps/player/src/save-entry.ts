/**
 * Pre-flight check of one entity entry of a save envelope. It lives apart from
 * PlayerRuntimeController (which needs a WebGL renderer and a DOM) so it can be unit-tested under
 * plain Node.
 *
 * loadSave applies nothing unless every entry passes, so a malformed entry must come back as a
 * structured failure. Before this existed the controller read `entry.position` straight off the
 * parsed document: a save whose entity entry was `null` threw a TypeError out of loadSave (no
 * `save.restoreFailed` log, no structured result), and a falsy-but-present `position` (`0`,
 * `false`, `""`) was silently skipped as if it were absent.
 */

export type Vec3Tuple = [number, number, number];

export interface PreflightedEntitySaveEntry {
  ok: true;
  position?: Vec3Tuple;
  rotation?: Vec3Tuple;
  /** The gameplay payload, present only when the entry carries one. */
  gameplay?: Record<string, unknown>;
}

export interface RejectedEntitySaveEntry {
  ok: false;
  error: string;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function readVec3(value: unknown): Vec3Tuple | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((component) => typeof component !== "number" || !Number.isFinite(component))
  ) {
    return undefined;
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

export function preflightEntitySaveEntry(
  entityId: string,
  entry: unknown,
): PreflightedEntitySaveEntry | RejectedEntitySaveEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { ok: false, error: `Invalid save entry for entity "${entityId}": expected an object` };
  }
  const record = entry as Record<string, unknown>;
  const result: PreflightedEntitySaveEntry = { ok: true };

  if (isPresent(record.position)) {
    const position = readVec3(record.position);
    if (!position) {
      return { ok: false, error: `Invalid position coordinates for entity "${entityId}"` };
    }
    result.position = position;
  }

  if (isPresent(record.rotation)) {
    const rotation = readVec3(record.rotation);
    if (!rotation) {
      return { ok: false, error: `Invalid rotation coordinates for entity "${entityId}"` };
    }
    result.rotation = rotation;
  }

  if (isPresent(record.gameplay)) {
    if (typeof record.gameplay !== "object" || Array.isArray(record.gameplay)) {
      return { ok: false, error: `Invalid gameplay payload for entity "${entityId}"` };
    }
    result.gameplay = record.gameplay as Record<string, unknown>;
  }

  return result;
}
