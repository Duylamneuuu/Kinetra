/**
 * Morph targets (blend shapes) as a pure, renderer-independent contract.
 *
 * A glTF model can carry several meshes that each expose named morph targets.
 * Gameplay and agents address a target by its semantic name ("smile",
 * "blink"), never by a mesh index, so a name shared by several meshes (for
 * example a "blink" on both the face and the brow) is driven as one value.
 *
 * This module owns the catalog of names, validation of weight requests and the
 * resolution of a name into per-mesh influence slots. It never touches
 * Three.js; the runtime adapter reads `morphTargetDictionary` /
 * `morphTargetInfluences` into `MorphTargetMeshDescriptor`s and writes the
 * resolved values back.
 */

export interface MorphTargetMeshDescriptor {
  /** Mesh (node) name, used only for observation. */
  meshName: string;
  /** Target names indexed by influence slot. */
  targetNames: readonly string[];
  /** Current influences, same length as `targetNames`. */
  influences: readonly number[];
}

export interface MorphTargetBinding {
  meshIndex: number;
  influenceIndex: number;
}

export interface MorphTargetCatalog {
  /** Unique target names, sorted by code point (locale independent). */
  names: readonly string[];
  /** Name -> every (mesh, slot) pair carrying that name, in mesh order. */
  bindings: ReadonlyMap<string, readonly MorphTargetBinding[]>;
}

export interface MorphTargetInfo {
  name: string;
  /** Weight of the first mesh slot carrying this name. */
  weight: number;
  /** Mesh names that carry this target, in mesh order. */
  meshes: string[];
}

export interface MorphTargetDiagnostic {
  code: string;
  message: string;
  remediation: string;
}

export interface MorphWeightUpdate {
  name: string;
  weight: number;
}

export type MorphValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: MorphTargetDiagnostic[] };

/**
 * Accepted weight range. glTF does not bound morph weights, but values outside
 * [0, 1] extrapolate the authored shape and are almost always a bug in
 * gameplay code, so the runtime contract rejects them explicitly.
 */
export const MORPH_WEIGHT_MIN = 0;
export const MORPH_WEIGHT_MAX = 1;

const MAX_LISTED_NAMES = 20;

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function buildMorphTargetCatalog(
  meshes: readonly MorphTargetMeshDescriptor[],
): MorphTargetCatalog {
  const bindings = new Map<string, MorphTargetBinding[]>();
  meshes.forEach((mesh, meshIndex) => {
    mesh.targetNames.forEach((name, influenceIndex) => {
      if (typeof name !== "string" || name.length === 0) return;
      if (influenceIndex >= mesh.influences.length) return;
      let list = bindings.get(name);
      if (!list) {
        list = [];
        bindings.set(name, list);
      }
      list.push({ meshIndex, influenceIndex });
    });
  });
  const names = [...bindings.keys()].sort(compareCodePoints);
  return { names, bindings };
}

export function summarizeMorphTargets(
  catalog: MorphTargetCatalog,
  meshes: readonly MorphTargetMeshDescriptor[],
): MorphTargetInfo[] {
  return catalog.names.map((name) => {
    const list = catalog.bindings.get(name) ?? [];
    const first = list[0];
    const weight = first ? meshes[first.meshIndex]?.influences[first.influenceIndex] ?? 0 : 0;
    const meshNames: string[] = [];
    for (const binding of list) {
      const meshName = meshes[binding.meshIndex]?.meshName ?? "";
      if (!meshNames.includes(meshName)) meshNames.push(meshName);
    }
    return { name, weight, meshes: meshNames };
  });
}

function unknownTargetDiagnostic(name: string, catalog: MorphTargetCatalog): MorphTargetDiagnostic {
  const lower = name.toLowerCase();
  const caseMatch = catalog.names.find((candidate) => candidate.toLowerCase() === lower);
  const listed = catalog.names.slice(0, MAX_LISTED_NAMES).join(", ");
  const more = catalog.names.length > MAX_LISTED_NAMES ? ", ..." : "";
  return {
    code: "anim.morph.unknownTarget",
    message: `Morph target "${name}" does not exist on this model`,
    remediation:
      catalog.names.length === 0
        ? "This model has no morph targets; export blend shapes from the DCC tool first."
        : caseMatch !== undefined
          ? `Target names are case-sensitive; did you mean "${caseMatch}"?`
          : `Use one of: ${listed}${more}.`,
  };
}

/**
 * Validates a `{ [targetName]: weight }` request against a catalog. The request
 * is all-or-nothing: any invalid entry rejects the whole request so a caller
 * never observes a half-applied expression.
 */
export function validateMorphWeightRequest(
  input: unknown,
  catalog: MorphTargetCatalog,
): MorphValidationResult<MorphWeightUpdate[]> {
  if (!isPlainRecord(input)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "anim.morph.invalidRequest",
          message: "Morph weights must be an object mapping target names to numbers",
          remediation: 'Pass weights like { "smile": 0.5, "blink": 1 }.',
        },
      ],
    };
  }
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "anim.morph.emptyRequest",
          message: "Morph weight request contains no targets",
          remediation: "Name at least one morph target to set.",
        },
      ],
    };
  }

  const diagnostics: MorphTargetDiagnostic[] = [];
  const updates: MorphWeightUpdate[] = [];
  for (const [name, weight] of entries) {
    if (!catalog.bindings.has(name)) {
      diagnostics.push(unknownTargetDiagnostic(name, catalog));
      continue;
    }
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      diagnostics.push({
        code: "anim.morph.weightNotFinite",
        message: `Weight for morph target "${name}" must be a finite number, got ${String(weight)}`,
        remediation: `Pass a number between ${MORPH_WEIGHT_MIN} and ${MORPH_WEIGHT_MAX}.`,
      });
      continue;
    }
    if (weight < MORPH_WEIGHT_MIN || weight > MORPH_WEIGHT_MAX) {
      diagnostics.push({
        code: "anim.morph.weightOutOfRange",
        message: `Weight ${weight} for morph target "${name}" is outside [${MORPH_WEIGHT_MIN}, ${MORPH_WEIGHT_MAX}]`,
        remediation: `Clamp the weight to [${MORPH_WEIGHT_MIN}, ${MORPH_WEIGHT_MAX}] before sending it.`,
      });
      continue;
    }
    // Normalise -0 so observation never reports a negative zero.
    updates.push({ name, weight: weight === 0 ? 0 : weight });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  updates.sort((a, b) => compareCodePoints(a.name, b.name));
  return { ok: true, value: updates };
}

/**
 * Validates the target list of a clear request. `undefined` means "all
 * currently overridden targets" and resolves to `undefined`.
 */
export function validateMorphTargetNames(
  input: unknown,
  catalog: MorphTargetCatalog,
): MorphValidationResult<string[] | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(input) || input.some((name) => typeof name !== "string")) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "anim.morph.invalidRequest",
          message: "Morph target names must be an array of strings",
          remediation: 'Pass names like ["smile", "blink"], or omit them to clear every override.',
        },
      ],
    };
  }
  const diagnostics: MorphTargetDiagnostic[] = [];
  const names = new Set<string>();
  for (const name of input as string[]) {
    if (!catalog.bindings.has(name)) {
      diagnostics.push(unknownTargetDiagnostic(name, catalog));
    } else {
      names.add(name);
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: [...names].sort(compareCodePoints) };
}

/**
 * Writes `weight` into every slot bound to `name`. `influences[i]` must be the
 * mutable influence array of `meshes[i]` in catalog order. Returns how many
 * slots were written.
 */
export function applyMorphWeight(
  catalog: MorphTargetCatalog,
  influences: readonly number[][],
  name: string,
  weight: number,
): number {
  const list = catalog.bindings.get(name);
  if (!list) return 0;
  let written = 0;
  for (const { meshIndex, influenceIndex } of list) {
    const target = influences[meshIndex];
    if (target && influenceIndex < target.length) {
      target[influenceIndex] = weight;
      written++;
    }
  }
  return written;
}
