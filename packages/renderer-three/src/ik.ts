/**
 * IK runtime adapter: applies the pure `@kinetra/animation/ik` solver to the
 * bones of one model instance.
 *
 * Targets are engine-owned state stored here (never read back from Three.js).
 * `apply()` runs after `mixer.update()` each frame so IK corrections sit on top
 * of the animated pose. The controller remembers the local rotations it read
 * and wrote last frame: a bone the mixer did not rewrite since (a static model,
 * a bone no clip animates) is restored to its input rotation before solving
 * again, so partial weights never compound across frames and clearing a target
 * returns the bones to their un-IK'd pose. Chains apply in chain-id order.
 * Chains whose bones are missing from the instance are rejected up front with structured diagnostics; nothing here throws on
 * malformed input.
 */
import {
  solveIkChain,
  validateIkChainDefinition,
  type IkChainDefinition,
  type IkDiagnostic,
  type IkVec3,
} from "@kinetra/animation/ik";
import * as THREE from "three";

export interface IkTargetOptions {
  pole?: IkVec3;
  /** Overrides the chain's weight for this target, 0..1. */
  weight?: number;
}

export interface IkSetTargetResult {
  success: boolean;
  diagnostics: IkDiagnostic[];
  error?: string;
}

export interface IkChainObservation {
  chainId: string;
  target: IkVec3;
  reachable: boolean;
  converged: boolean;
  error: number;
}

interface AppliedRotation {
  bone: THREE.Object3D;
  input: THREE.Quaternion;
  output: THREE.Quaternion;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface ActiveTarget {
  target: IkVec3;
  options: IkTargetOptions;
  last?: IkChainObservation;
}

function diag(code: string, message: string, remediation: string): IkDiagnostic {
  return { code, severity: "error", message, remediation };
}

function fail(diagnostics: IkDiagnostic[]): IkSetTargetResult {
  return { success: false, diagnostics, error: diagnostics.map((d) => `[${d.code}] ${d.message}`).join("; ") };
}

function isVec3(v: unknown): v is IkVec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export class IkController {
  readonly #definitions: readonly IkChainDefinition[];
  readonly #chains = new Map<string, { definition: IkChainDefinition; bones: THREE.Object3D[] }>();
  readonly #targets = new Map<string, ActiveTarget>();
  readonly #diagnostics: IkDiagnostic[] = [];
  /** Rotations written by the last apply(), in write order. */
  #applied: AppliedRotation[] = [];

  /** Registers every valid chain whose bones all exist under `root`; others yield diagnostics. */
  constructor(root: THREE.Object3D, definitions: readonly IkChainDefinition[]) {
    this.#definitions = [...definitions];
    for (const definition of definitions) {
      if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
        this.#diagnostics.push(
          diag("ik.chain.invalid", "IK chain definition must be an object", "Pass { schemaVersion: 1, id, solver, joints }."),
        );
        continue;
      }
      const errors = validateIkChainDefinition(definition).filter((d) => d.severity === "error");
      if (errors.length > 0) {
        this.#diagnostics.push(...errors);
        continue;
      }
      if (this.#chains.has(definition.id)) {
        this.#diagnostics.push(
          diag("ik.chain.duplicate", `Chain "${definition.id}" is defined twice`, "Give each chain a unique id."),
        );
        continue;
      }
      const bones: THREE.Object3D[] = [];
      const missing: string[] = [];
      for (const name of definition.joints) {
        const bone = root.getObjectByName(name);
        if (bone) bones.push(bone);
        else missing.push(name);
      }
      if (missing.length > 0) {
        this.#diagnostics.push(
          diag(
            "ik.chain.missing-bone",
            `Chain "${definition.id}" references bones not in the model: ${missing.join(", ")}`,
            "Use bone (node) names that exist in the glTF skeleton.",
          ),
        );
        continue;
      }
      this.#chains.set(definition.id, { definition, bones });
    }
  }

  /** The chain definitions this controller was built from (including rejected ones), in input order. */
  get definitions(): readonly IkChainDefinition[] {
    return this.#definitions;
  }

  /**
   * Copies active targets from a controller bound to a previous instance of the
   * same entity (e.g. before a hot reimport). Targets whose chain this
   * controller did not register are dropped; their chain ids are returned sorted.
   */
  adoptTargets(previous: IkController): string[] {
    const dropped: string[] = [];
    for (const [chainId, active] of previous.#targets) {
      if (!this.#chains.has(chainId)) {
        dropped.push(chainId);
        continue;
      }
      this.#targets.set(chainId, {
        target: [active.target[0], active.target[1], active.target[2]],
        options: { ...active.options },
      });
    }
    return dropped.sort();
  }

  get chainIds(): string[] {
    return [...this.#chains.keys()].sort();
  }

  /** Diagnostics from chain registration (invalid / duplicate / missing-bone chains). */
  get registrationDiagnostics(): readonly IkDiagnostic[] {
    return this.#diagnostics;
  }

  get activeCount(): number {
    return this.#targets.size;
  }

  setTarget(chainId: unknown, target: unknown, options: IkTargetOptions = {}): IkSetTargetResult {
    if (typeof chainId !== "string" || !this.#chains.has(chainId)) {
      return fail([
        diag(
          "ik.target.unknown-chain",
          `Unknown IK chain "${String(chainId)}"`,
          `Use one of: ${this.chainIds.join(", ") || "(no chains registered)"}.`,
        ),
      ]);
    }
    if (!isVec3(target)) {
      return fail([diag("ik.target.invalid", "Target must be three finite numbers", "Pass [x, y, z] in world metres.")]);
    }
    const opts = options ?? {};
    if (opts.pole !== undefined && !isVec3(opts.pole)) {
      return fail([diag("ik.target.invalid-pole", "Pole must be three finite numbers", "Pass [x, y, z] or omit it.")]);
    }
    if (opts.weight !== undefined && (!Number.isFinite(opts.weight) || opts.weight < 0 || opts.weight > 1)) {
      return fail([diag("ik.target.invalid-weight", "Weight must be within 0..1", "Pass a number from 0 to 1.")]);
    }
    // Own copies of every vector: a caller reusing a scratch array (or writing NaN into it later)
    // must not change, or poison, the stored target after validation has passed.
    const stored: IkTargetOptions = {};
    if (opts.pole !== undefined) stored.pole = [opts.pole[0], opts.pole[1], opts.pole[2]];
    if (opts.weight !== undefined) stored.weight = opts.weight;
    this.#targets.set(chainId, { target: [target[0], target[1], target[2]], options: stored });
    return { success: true, diagnostics: [] };
  }

  /** Removes the target for `chainId` (or all targets). The next mixer update restores the animated pose. */
  clearTarget(chainId?: string): void {
    if (chainId === undefined) this.#targets.clear();
    else this.#targets.delete(chainId);
    // Undo this controller's last corrections now; remaining targets are re-solved on the next apply().
    this.#restoreInputPose();
  }

  /** Puts back the input rotation of every bone the mixer has not rewritten since the last apply(). */
  #restoreInputPose(): void {
    for (let i = this.#applied.length - 1; i >= 0; i--) {
      const { bone, input, output } = this.#applied[i]!;
      if (bone.quaternion.equals(output)) {
        bone.quaternion.copy(input);
        bone.updateWorldMatrix(false, true);
      }
    }
    this.#applied = [];
  }

  observe(): IkChainObservation[] {
    // Observations are copies: editing one must never move the stored target.
    return [...this.#targets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([chainId, t]) => ({
        ...(t.last ?? { chainId, reachable: false, converged: false, error: NaN }),
        target: [t.target[0], t.target[1], t.target[2]] as IkVec3,
      }));
  }

  /** Call after `mixer.update()`. Mutates bone local rotations only. */
  apply(): void {
    this.#restoreInputPose();
    const ordered = [...this.#targets].sort(([a], [b]) => compareIds(a, b));
    for (const [chainId, active] of ordered) {
      const chain = this.#chains.get(chainId);
      if (!chain) continue;
      const { bones, definition } = chain;
      bones[0]!.updateWorldMatrix(true, true);
      const positions = bones.map((b) => b.getWorldPosition(new THREE.Vector3()).toArray() as unknown as IkVec3);
      const result = solveIkChain(definition, positions, active.target, {
        pole: active.options.pole,
        weight: active.options.weight,
      });
      active.last = {
        chainId,
        target: active.target,
        reachable: result.reachable,
        converged: result.converged,
        error: result.error,
      };
      if (!result.success) continue;

      // Root -> tip: re-measure each bone's current direction after its parents moved.
      for (let i = 0; i + 1 < bones.length; i++) {
        const bone = bones[i]!;
        bone.updateWorldMatrix(true, true);
        const here = bone.getWorldPosition(new THREE.Vector3());
        const next = bones[i + 1]!.getWorldPosition(new THREE.Vector3());
        const from = next.sub(here);
        const to = new THREE.Vector3(...result.positions[i + 1]!).sub(new THREE.Vector3(...result.positions[i]!));
        if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) continue;
        const aim = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
        const worldQuat = bone.getWorldQuaternion(new THREE.Quaternion());
        const parentQuat = bone.parent
          ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
          : new THREE.Quaternion();
        const input = bone.quaternion.clone();
        bone.quaternion.copy(parentQuat.invert().multiply(aim.multiply(worldQuat)));
        this.#applied.push({ bone, input, output: bone.quaternion.clone() });
        bone.updateWorldMatrix(false, true);
      }
    }
  }
}
