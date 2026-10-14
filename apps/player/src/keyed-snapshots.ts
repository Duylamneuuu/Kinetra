/**
 * Pure builders for the two author-keyed records PlayerRuntimeController hands out: the entity
 * map of a save envelope and the `byId` map of the `assets` runtime query.
 *
 * They live apart from the controller (which needs a WebGL renderer and a DOM) so the real
 * capture path can be tested under plain Node. Entity and asset ids are author-chosen, so
 * `__proto__`, `constructor` and `hasOwnProperty` are legal ids; both records are prototype-less
 * (see ./keyed-record.ts) and every id stays an own key through `JSON.stringify`/`JSON.parse`.
 */

import { createKeyedRecord } from "./keyed-record.js";

export interface CapturedObjectTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

export interface CapturedEntityState {
  position: [number, number, number];
  rotation: [number, number, number];
  /** A deep copy of the script's gameplay state, present only when the script has some. */
  gameplay?: Record<string, unknown>;
}

/**
 * Builds the `entities` record of a save from the live objects. `readGameplay` returns the live
 * script state of an entity (or undefined); the save gets a structured clone so it never aliases
 * state the script keeps mutating.
 */
export function captureEntityStates(
  objects: Iterable<readonly [string, CapturedObjectTransform]>,
  readGameplay: (entityId: string) => Record<string, unknown> | undefined,
): Record<string, CapturedEntityState> {
  const entries: Array<[string, CapturedEntityState]> = [];
  for (const [entityId, obj] of objects) {
    const gameplay = readGameplay(entityId);
    entries.push([
      entityId,
      {
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
        ...(gameplay ? { gameplay: structuredClone(gameplay) } : {}),
      },
    ]);
  }
  return createKeyedRecord(entries);
}

export interface AssetQueryLookups<Status extends string> {
  sourceHashes: ReadonlyMap<string, string>;
  fingerprints: ReadonlyMap<string, string>;
  statuses: ReadonlyMap<string, Status>;
  revisions: ReadonlyMap<string, number>;
}

export interface AssetQueryEntry<Status extends string> {
  assetId: string;
  sourceHash?: string;
  fingerprint?: string;
  importStatus: Status | "imported";
  revision?: number;
}

/** Builds the `byId` record of the `assets` runtime query; an asset with no status is "imported". */
export function buildAssetQueryById<Status extends string = string>(
  assetIds: Iterable<string>,
  lookups: AssetQueryLookups<Status>,
): Record<string, AssetQueryEntry<Status>> {
  const entries: Array<[string, AssetQueryEntry<Status>]> = [];
  for (const assetId of assetIds) {
    entries.push([
      assetId,
      {
        assetId,
        ...(lookups.sourceHashes.has(assetId) ? { sourceHash: lookups.sourceHashes.get(assetId) as string } : {}),
        ...(lookups.fingerprints.has(assetId) ? { fingerprint: lookups.fingerprints.get(assetId) as string } : {}),
        importStatus: lookups.statuses.get(assetId) ?? "imported",
        ...(lookups.revisions.has(assetId) ? { revision: lookups.revisions.get(assetId) as number } : {}),
      },
    ]);
  }
  return createKeyedRecord(entries);
}
