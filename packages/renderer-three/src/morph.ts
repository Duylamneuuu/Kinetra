import {
  applyMorphWeight,
  buildMorphTargetCatalog,
  summarizeMorphTargets,
  validateMorphTargetNames,
  validateMorphWeightRequest,
  type MorphTargetCatalog,
  type MorphTargetDiagnostic,
  type MorphTargetMeshDescriptor,
  type MorphWeightUpdate,
} from "@kinetra/animation/morph-targets.js";
import type * as THREE from "three";

import type { ModelMorphTargetsState } from "./assets.js";

export type { MorphTargetDiagnostic, MorphWeightUpdate };

export interface MorphOperationResult {
  success: boolean;
  diagnostics?: MorphTargetDiagnostic[] | undefined;
  error?: string | undefined;
}

export interface MorphSetResult extends MorphOperationResult {
  applied?: MorphWeightUpdate[] | undefined;
}

export interface MorphClearResult extends MorphOperationResult {
  cleared?: string[] | undefined;
}

type MorphMesh = THREE.Mesh & {
  morphTargetDictionary: Record<string, number>;
  morphTargetInfluences: number[];
};

function isMorphMesh(object: THREE.Object3D): object is MorphMesh {
  const mesh = object as Partial<MorphMesh> & { isMesh?: boolean };
  return (
    mesh.isMesh === true &&
    Array.isArray(mesh.morphTargetInfluences) &&
    mesh.morphTargetInfluences.length > 0 &&
    typeof mesh.morphTargetDictionary === "object" &&
    mesh.morphTargetDictionary !== null
  );
}

function targetNamesOf(mesh: MorphMesh): string[] {
  const names = new Array<string>(mesh.morphTargetInfluences.length).fill("");
  for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
    if (Number.isInteger(index) && index >= 0 && index < names.length) {
      names[index] = name;
    }
  }
  return names;
}

function failure(diagnostics: MorphTargetDiagnostic[]): MorphOperationResult {
  return {
    success: false,
    diagnostics,
    error: diagnostics.map((d) => `[${d.code}] ${d.message}`).join("; "),
  };
}

/**
 * Engine-owned morph-target state for one model instance.
 *
 * Overrides are the source of truth: they are stored here, not read back from
 * Three.js, and are re-applied after every mixer update so they win over clip
 * tracks that animate the same targets. Clearing an override restores the
 * instance's bind-time default so an un-animated mesh returns to its authored
 * shape.
 */
export class MorphTargetController {
  readonly #meshes: MorphMesh[];
  readonly #targetNames: string[][];
  readonly #defaults: number[][];
  readonly #catalog: MorphTargetCatalog;
  readonly #overrides = new Map<string, number>();

  private constructor(meshes: MorphMesh[]) {
    this.#meshes = meshes;
    this.#targetNames = meshes.map(targetNamesOf);
    this.#defaults = meshes.map((mesh) => [...mesh.morphTargetInfluences]);
    this.#catalog = buildMorphTargetCatalog(this.#descriptors());
  }

  /** Returns undefined when the scene has no mesh with morph targets. */
  static fromScene(root: THREE.Object3D): MorphTargetController | undefined {
    const meshes: MorphMesh[] = [];
    root.traverse((child) => {
      if (isMorphMesh(child)) meshes.push(child);
    });
    if (meshes.length === 0) return undefined;
    const controller = new MorphTargetController(meshes);
    return controller.#catalog.names.length > 0 ? controller : undefined;
  }

  get targetNames(): readonly string[] {
    return this.#catalog.names;
  }

  /** Names that currently carry a runtime override, sorted. */
  overriddenNames(): string[] {
    return [...this.#overrides.keys()].sort();
  }

  get overrideCount(): number {
    return this.#overrides.size;
  }

  #descriptors(): MorphTargetMeshDescriptor[] {
    return this.#meshes.map((mesh, index) => ({
      meshName: mesh.name,
      targetNames: this.#targetNames[index] ?? [],
      influences: mesh.morphTargetInfluences,
    }));
  }

  #influences(): number[][] {
    return this.#meshes.map((mesh) => mesh.morphTargetInfluences);
  }

  setWeights(weights: unknown): MorphSetResult {
    const validation = validateMorphWeightRequest(weights, this.#catalog);
    if (!validation.ok) return failure(validation.diagnostics);
    const influences = this.#influences();
    for (const { name, weight } of validation.value) {
      this.#overrides.set(name, weight);
      applyMorphWeight(this.#catalog, influences, name, weight);
    }
    return { success: true, applied: validation.value };
  }

  clear(names?: unknown): MorphClearResult {
    const validation = validateMorphTargetNames(names, this.#catalog);
    if (!validation.ok) return failure(validation.diagnostics);
    const requested = validation.value ?? [...this.#overrides.keys()].sort();
    const cleared: string[] = [];
    for (const name of requested) {
      if (!this.#overrides.delete(name)) continue;
      cleared.push(name);
      for (const { meshIndex, influenceIndex } of this.#catalog.bindings.get(name) ?? []) {
        const mesh = this.#meshes[meshIndex];
        const fallback = this.#defaults[meshIndex]?.[influenceIndex] ?? 0;
        if (mesh) mesh.morphTargetInfluences[influenceIndex] = fallback;
      }
    }
    return { success: true, cleared };
  }

  /** Re-applies every override; call after the mixer has written clip values. */
  applyOverrides(): void {
    if (this.#overrides.size === 0) return;
    const influences = this.#influences();
    for (const [name, weight] of this.#overrides) {
      applyMorphWeight(this.#catalog, influences, name, weight);
    }
  }

  /**
   * Carries overrides across an asset reload. Targets that no longer exist on
   * the new asset are dropped and returned so the caller can report them.
   */
  adoptOverrides(previous: MorphTargetController): string[] {
    const dropped: string[] = [];
    const kept: Record<string, number> = {};
    for (const [name, weight] of previous.#overrides) {
      if (this.#catalog.bindings.has(name)) kept[name] = weight;
      else dropped.push(name);
    }
    if (Object.keys(kept).length > 0) this.setWeights(kept);
    return dropped.sort();
  }

  observe(): ModelMorphTargetsState {
    const overrides: Record<string, number> = {};
    for (const name of this.overriddenNames()) {
      overrides[name] = this.#overrides.get(name) as number;
    }
    return {
      targets: summarizeMorphTargets(this.#catalog, this.#descriptors()).map((info) => ({
        ...info,
        overridden: this.#overrides.has(info.name),
      })),
      overrides,
    };
  }
}
