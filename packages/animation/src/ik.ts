/**
 * Inverse kinematics (IK) as a pure, text-backed contract.
 *
 * This module owns the chain definition, its validation and two deterministic
 * solvers that operate on plain world-space joint positions:
 *
 * - `solveTwoBoneIk`: analytic law-of-cosines solver for limbs (arm, leg)
 *   with an optional pole hint that picks the bend plane;
 * - `solveFabrikIk`: iterative FABRIK solver (Aristidou & Lasenby, 2011,
 *   "FABRIK: A fast, iterative solver for the Inverse Kinematics problem")
 *   for chains of any length (tails, spines, tentacles).
 *
 * It does not touch Three.js and never mutates its inputs. A runtime adapter
 * reads bone world positions, calls a solver, converts the result to bone
 * rotations with `computeBoneAimRotations`, and writes the visual pose. Like
 * every other animation layer, IK only produces a *visual* pose: physics and
 * gameplay remain authoritative over entity transforms.
 *
 * Algorithms are implemented from their published descriptions; no
 * third-party code is copied.
 */

export type IkVec3 = readonly [number, number, number];
/** Quaternion as `[x, y, z, w]`, matching glTF and Three.js component order. */
export type IkQuat = readonly [number, number, number, number];

export type IkSolverKind = "two-bone" | "fabrik";

export interface IkChainDefinition {
  schemaVersion: 1;
  id: string;
  solver: IkSolverKind;
  /** Joint (bone) names ordered root -> end effector. `two-bone` needs exactly 3. */
  joints: string[];
  /** Acceptable end-effector distance to the target, in metres. FABRIK only. */
  tolerance?: number;
  /** FABRIK iteration budget. */
  maxIterations?: number;
  /** 0 keeps the input pose, 1 reaches fully for the target. */
  weight?: number;
}

export type IkDiagnosticSeverity = "error" | "warning" | "info";

export interface IkDiagnostic {
  code: string;
  severity: IkDiagnosticSeverity;
  message: string;
  remediation: string;
}

export interface IkSolveOptions {
  /** World-space point the middle joint should bend towards. Two-bone only. */
  pole?: IkVec3 | undefined;
  tolerance?: number | undefined;
  maxIterations?: number | undefined;
  weight?: number | undefined;
}

export interface IkSolveResult {
  /** False when the inputs were unusable; `positions` is then a copy of the input. */
  success: boolean;
  /** Solved world-space joint positions, root -> end effector. */
  positions: IkVec3[];
  /** Whether the (weighted) target lies within the chain's reach. */
  reachable: boolean;
  /** Whether the end effector ended within tolerance of the (weighted) target. */
  converged: boolean;
  iterations: number;
  /** Distance from the solved end effector to the (weighted) target. */
  error: number;
  diagnostics: IkDiagnostic[];
}

export const IK_DEFAULT_TOLERANCE = 1e-4;
export const IK_DEFAULT_MAX_ITERATIONS = 16;
/** Upper bound accepted for `maxIterations`, keeping per-frame cost bounded. */
export const IK_MAX_ITERATIONS_LIMIT = 1024;
/** Bones shorter than this are treated as degenerate. */
export const IK_MIN_BONE_LENGTH = 1e-6;

const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateIkChainDefinition(definition: IkChainDefinition): IkDiagnostic[] {
  const diagnostics: IkDiagnostic[] = [];
  const raw = definition as unknown as Record<string, unknown>;

  if (raw.schemaVersion !== 1) {
    diagnostics.push(
      error(
        "ik.chain.schema.unsupported",
        `IK chain schemaVersion ${String(raw.schemaVersion)} is not supported`,
        "Set schemaVersion to 1.",
      ),
    );
  }
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    diagnostics.push(
      error("ik.chain.id.empty", "IK chain has no id", "Give the chain a stable, non-empty id such as \"leftLeg\"."),
    );
  }
  if (raw.solver !== "two-bone" && raw.solver !== "fabrik") {
    diagnostics.push(
      error(
        "ik.chain.solver.unknown",
        `Unknown IK solver "${String(raw.solver)}"`,
        "Use \"two-bone\" for limbs or \"fabrik\" for longer chains.",
      ),
    );
  }

  const joints = Array.isArray(raw.joints) ? (raw.joints as unknown[]) : undefined;
  if (!joints) {
    diagnostics.push(
      error("ik.chain.joints.missing", "IK chain has no joints array", "List joint names ordered root -> end effector."),
    );
  } else {
    if (joints.length < 2) {
      diagnostics.push(
        error(
          "ik.chain.joints.too-few",
          `IK chain needs at least 2 joints, got ${joints.length}`,
          "List at least a root joint and an end-effector joint.",
        ),
      );
    }
    if (raw.solver === "two-bone" && joints.length !== 3) {
      diagnostics.push(
        error(
          "ik.chain.joints.two-bone-count",
          `two-bone IK needs exactly 3 joints (root, mid, end), got ${joints.length}`,
          "Use exactly three joints, e.g. [\"LeftUpLeg\", \"LeftLeg\", \"LeftFoot\"], or switch to the fabrik solver.",
        ),
      );
    }
    const seen = new Set<string>();
    joints.forEach((joint, index) => {
      if (typeof joint !== "string" || joint.trim() === "") {
        diagnostics.push(
          error("ik.chain.joint.empty", `Joint at index ${index} has no name`, "Every joint must be a non-empty bone name."),
        );
        return;
      }
      if (seen.has(joint)) {
        diagnostics.push(
          error(
            "ik.chain.joint.duplicate",
            `Joint "${joint}" appears more than once`,
            "Each bone may appear only once in a chain.",
          ),
        );
      }
      seen.add(joint);
    });
  }

  diagnostics.push(...validateNumericOptions(raw.tolerance, raw.maxIterations, raw.weight, "ik.chain"));
  return diagnostics;
}

function validateNumericOptions(
  tolerance: unknown,
  maxIterations: unknown,
  weight: unknown,
  prefix: string,
): IkDiagnostic[] {
  const diagnostics: IkDiagnostic[] = [];
  if (tolerance !== undefined && !(typeof tolerance === "number" && Number.isFinite(tolerance) && tolerance > 0)) {
    diagnostics.push(
      error(`${prefix}.tolerance.invalid`, `tolerance must be a finite number > 0, got ${String(tolerance)}`, "Use a small positive distance such as 0.001."),
    );
  }
  if (
    maxIterations !== undefined &&
    !(
      typeof maxIterations === "number" &&
      Number.isInteger(maxIterations) &&
      maxIterations >= 1 &&
      maxIterations <= IK_MAX_ITERATIONS_LIMIT
    )
  ) {
    diagnostics.push(
      error(
        `${prefix}.iterations.invalid`,
        `maxIterations must be an integer in [1, ${IK_MAX_ITERATIONS_LIMIT}], got ${String(maxIterations)}`,
        "Use a small integer budget such as 16.",
      ),
    );
  }
  if (weight !== undefined && !(typeof weight === "number" && Number.isFinite(weight) && weight >= 0 && weight <= 1)) {
    diagnostics.push(
      error(`${prefix}.weight.invalid`, `weight must be a number in [0, 1], got ${String(weight)}`, "Use 0 to disable IK and 1 for full reach."),
    );
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Solvers
// ---------------------------------------------------------------------------

/**
 * Analytic two-bone IK. `root`, `mid`, `end` are current world positions.
 * Bone lengths are preserved exactly; an out-of-reach target is approached
 * along the root->target line as far as the limb allows.
 */
export function solveTwoBoneIk(
  root: IkVec3,
  mid: IkVec3,
  end: IkVec3,
  target: IkVec3,
  options: IkSolveOptions = {},
): IkSolveResult {
  const input: IkVec3[] = [copy(root), copy(mid), copy(end)];
  const inputProblem = checkInputs(input, target, options, "two-bone");
  if (inputProblem) return failure(input, inputProblem);

  const diagnostics: IkDiagnostic[] = [];
  const upper = distance(root, mid);
  const lower = distance(mid, end);
  const weight = options.weight ?? 1;
  const goal = lerp(end, target, weight);

  const minReach = Math.abs(upper - lower);
  const maxReach = upper + lower;
  const toGoal = sub(goal, root);
  const goalDistance = length(toGoal);

  let direction: IkVec3;
  if (goalDistance > EPSILON) {
    direction = scale(toGoal, 1 / goalDistance);
  } else {
    diagnostics.push(
      warning(
        "ik.solve.target-at-root",
        "IK target coincides with the chain root; reach direction is undefined",
        "Move the target away from the root joint. The current limb direction was kept.",
      ),
    );
    direction = normalizeOr(sub(end, root), normalizeOr(sub(mid, root), [0, 1, 0]));
  }

  const reachable = goalDistance <= maxReach + EPSILON && goalDistance >= minReach - EPSILON;
  if (!reachable) {
    diagnostics.push(
      info(
        goalDistance > maxReach ? "ik.solve.out-of-reach" : "ik.solve.inside-min-reach",
        goalDistance > maxReach
          ? `Target is ${round(goalDistance - maxReach)}m beyond the limb's reach`
          : `Target is ${round(minReach - goalDistance)}m inside the limb's minimum reach`,
        "The limb was extended (or folded) as far as possible towards the target.",
      ),
    );
  }
  const solvedDistance = clamp(goalDistance, minReach, maxReach);

  const bend = bendDirection(root, mid, direction, options.pole, diagnostics);
  const cosRoot = clamp(
    (upper * upper + solvedDistance * solvedDistance - lower * lower) / (2 * upper * Math.max(solvedDistance, EPSILON)),
    -1,
    1,
  );
  const sinRoot = Math.sqrt(Math.max(0, 1 - cosRoot * cosRoot));

  const solvedMid = add(root, add(scale(direction, upper * cosRoot), scale(bend, upper * sinRoot)));
  // Place the end effector from the solved mid so the lower bone length is exact
  // even when the reach was clamped (avoids drift from floating-point error).
  const solvedEnd = add(solvedMid, scale(normalizeOr(sub(add(root, scale(direction, solvedDistance)), solvedMid), direction), lower));

  const finalError = distance(solvedEnd, goal);
  return {
    success: true,
    positions: [copy(root), solvedMid, solvedEnd],
    reachable,
    converged: finalError <= (options.tolerance ?? IK_DEFAULT_TOLERANCE),
    iterations: 1,
    error: finalError,
    diagnostics,
  };
}

/**
 * Iterative FABRIK solver. `joints` are current world positions ordered
 * root -> end effector. The root stays fixed and every bone length is
 * preserved. Deterministic for identical inputs.
 */
export function solveFabrikIk(joints: readonly IkVec3[], target: IkVec3, options: IkSolveOptions = {}): IkSolveResult {
  const input = Array.isArray(joints) ? joints.map(copy) : [];
  const inputProblem = checkInputs(input, target, options, "fabrik");
  if (inputProblem) return failure(input, inputProblem);

  const diagnostics: IkDiagnostic[] = [];
  const tolerance = options.tolerance ?? IK_DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? IK_DEFAULT_MAX_ITERATIONS;
  const weight = options.weight ?? 1;
  const last = input.length - 1;
  const goal = lerp(input[last]!, target, weight);

  const lengths: number[] = [];
  const restDirections: IkVec3[] = [];
  for (let i = 0; i < last; i++) {
    const bone = sub(input[i + 1]!, input[i]!);
    const boneLength = length(bone);
    lengths.push(boneLength);
    restDirections.push(scale(bone, 1 / boneLength));
  }
  const totalLength = lengths.reduce((sum, value) => sum + value, 0);
  const root = input[0]!;
  const positions: [number, number, number][] = input.map((p) => [p[0], p[1], p[2]]);
  const rootToGoal = distance(root, goal);

  if (rootToGoal > totalLength + EPSILON) {
    // Unreachable: straighten the chain towards the target.
    const direction = scale(sub(goal, root), 1 / rootToGoal);
    for (let i = 0; i < last; i++) {
      set(positions[i + 1]!, add(positions[i]!, scale(direction, lengths[i]!)));
    }
    diagnostics.push(
      info(
        "ik.solve.out-of-reach",
        `Target is ${round(rootToGoal - totalLength)}m beyond the chain's reach`,
        "The chain was straightened towards the target.",
      ),
    );
    const finalError = distance(positions[last]!, goal);
    return {
      success: true,
      positions: positions.map(copy),
      reachable: false,
      converged: false,
      iterations: 0,
      error: finalError,
      diagnostics,
    };
  }

  let iterations = 0;
  let finalError = distance(positions[last]!, goal);
  while (finalError > tolerance && iterations < maxIterations) {
    iterations++;
    // Backward pass: pin the end effector to the goal.
    set(positions[last]!, goal);
    for (let i = last - 1; i >= 0; i--) {
      const fallback = scale(restDirections[i]!, -1);
      const toward = normalizeOr(sub(positions[i]!, positions[i + 1]!), fallback);
      set(positions[i]!, add(positions[i + 1]!, scale(toward, lengths[i]!)));
    }
    // Forward pass: pin the root back in place.
    set(positions[0]!, root);
    for (let i = 0; i < last; i++) {
      const toward = normalizeOr(sub(positions[i + 1]!, positions[i]!), restDirections[i]!);
      set(positions[i + 1]!, add(positions[i]!, scale(toward, lengths[i]!)));
    }
    finalError = distance(positions[last]!, goal);
  }

  const converged = finalError <= tolerance;
  if (!converged) {
    diagnostics.push(
      warning(
        "ik.solve.not-converged",
        `FABRIK stopped after ${iterations} iterations with ${round(finalError)}m error`,
        "Raise maxIterations or tolerance, or check that the target is reachable.",
      ),
    );
  }
  return {
    success: true,
    positions: positions.map(copy),
    reachable: true,
    converged,
    iterations,
    error: finalError,
    diagnostics,
  };
}

/**
 * Solves a validated chain definition. `positions` are the chain's current
 * world-space joint positions in definition order. Explicit `options` override
 * the definition's tolerance / iteration / weight settings.
 */
export function solveIkChain(
  definition: IkChainDefinition,
  positions: readonly IkVec3[],
  target: IkVec3,
  options: IkSolveOptions = {},
): IkSolveResult {
  const input = Array.isArray(positions) ? positions.map(copy) : [];
  const definitionDiagnostics = validateIkChainDefinition(definition).filter((d) => d.severity === "error");
  if (definitionDiagnostics.length > 0) return failure(input, definitionDiagnostics);

  if (input.length !== definition.joints.length) {
    return failure(input, [
      error(
        "ik.solve.joint-count-mismatch",
        `Chain "${definition.id}" has ${definition.joints.length} joints but ${input.length} positions were supplied`,
        "Supply one world position per joint, in definition order.",
      ),
    ]);
  }

  const merged: IkSolveOptions = {
    pole: options.pole,
    tolerance: options.tolerance ?? definition.tolerance,
    maxIterations: options.maxIterations ?? definition.maxIterations,
    weight: options.weight ?? definition.weight,
  };
  return definition.solver === "two-bone"
    ? solveTwoBoneIk(input[0]!, input[1]!, input[2]!, target, merged)
    : solveFabrikIk(input, target, merged);
}

// ---------------------------------------------------------------------------
// Pose conversion
// ---------------------------------------------------------------------------

/**
 * For each bone (joint i -> joint i+1) returns the world-space shortest-arc
 * rotation that turns its `before` direction into its `after` direction.
 * A runtime adapter pre-multiplies these onto each bone's world rotation.
 * Returns one quaternion per bone (`before.length - 1`); a bone whose direction is degenerate or
 * non-finite (zero length, NaN, Infinity) gets the identity rotation.
 */
export function computeBoneAimRotations(before: readonly IkVec3[], after: readonly IkVec3[]): IkQuat[] {
  if (before.length !== after.length) {
    throw new RangeError(`computeBoneAimRotations: before has ${before.length} joints, after has ${after.length}`);
  }
  const rotations: IkQuat[] = [];
  for (let i = 0; i + 1 < before.length; i++) {
    const rawFrom = sub(before[i + 1]!, before[i]!);
    const rawTo = sub(after[i + 1]!, after[i]!);
    // A non-finite bone (NaN/Infinity position) has no direction; scaling Infinity by 1/Infinity
    // would otherwise yield a NaN quaternion that poisons the whole pose.
    if (!isFiniteVec3(rawFrom) || !isFiniteVec3(rawTo)) {
      rotations.push([0, 0, 0, 1]);
      continue;
    }
    const from = normalizeOr(rawFrom, [0, 0, 0]);
    const to = normalizeOr(rawTo, [0, 0, 0]);
    if (length(from) < 0.5 || length(to) < 0.5) {
      rotations.push([0, 0, 0, 1]);
      continue;
    }
    rotations.push(shortestArc(from, to));
  }
  return rotations;
}

/** Rotates `v` by quaternion `q` (`[x, y, z, w]`). Exposed for adapters and tests. */
export function rotateVectorByQuat(v: IkVec3, q: IkQuat): IkVec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

function shortestArc(from: IkVec3, to: IkVec3): IkQuat {
  const d = dot(from, to);
  if (d < -1 + 1e-9) {
    // Opposite directions: rotate 180 degrees about any axis perpendicular to `from`.
    const axis = normalizeOr(cross(from, leastAlignedAxis(from)), [1, 0, 0]);
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(from, to);
  const q: [number, number, number, number] = [c[0], c[1], c[2], 1 + d];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function bendDirection(
  root: IkVec3,
  mid: IkVec3,
  direction: IkVec3,
  pole: IkVec3 | undefined,
  diagnostics: IkDiagnostic[],
): IkVec3 {
  if (pole) {
    const fromPole = perpendicularComponent(sub(pole, root), direction);
    if (fromPole) return fromPole;
    diagnostics.push(
      warning(
        "ik.solve.pole-degenerate",
        "Pole lies on the root->target line and cannot define a bend plane",
        "Move the pole off the root->target line (e.g. in front of the knee). The current bend plane was kept.",
      ),
    );
  }
  const fromMid = perpendicularComponent(sub(mid, root), direction);
  if (fromMid) return fromMid;
  // Straight limb aligned with the target: pick a deterministic perpendicular.
  return normalizeOr(cross(direction, leastAlignedAxis(direction)), [1, 0, 0]);
}

function perpendicularComponent(v: IkVec3, unitAxis: IkVec3): IkVec3 | undefined {
  const projected = sub(v, scale(unitAxis, dot(v, unitAxis)));
  const projectedLength = length(projected);
  const reference = Math.max(length(v), 1);
  if (projectedLength <= 1e-7 * reference) return undefined;
  return scale(projected, 1 / projectedLength);
}

function leastAlignedAxis(v: IkVec3): IkVec3 {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  if (ax <= ay && ax <= az) return [1, 0, 0];
  if (ay <= az) return [0, 1, 0];
  return [0, 0, 1];
}

function checkInputs(
  joints: readonly IkVec3[],
  target: IkVec3,
  options: IkSolveOptions,
  solver: IkSolverKind,
): IkDiagnostic[] | undefined {
  const problems: IkDiagnostic[] = [];
  if (solver === "two-bone" ? joints.length !== 3 : joints.length < 2) {
    problems.push(
      error(
        "ik.solve.joint-count",
        solver === "two-bone"
          ? `two-bone IK needs 3 joint positions, got ${joints.length}`
          : `FABRIK needs at least 2 joint positions, got ${joints.length}`,
        "Supply one world position per joint, root -> end effector.",
      ),
    );
    return problems;
  }
  const vectors: Array<IkVec3 | undefined> = [...joints, target, options.pole];
  if (!vectors.every((v) => v === undefined || isFiniteVec3(v))) {
    problems.push(
      error(
        "ik.solve.non-finite",
        "IK input contains a non-finite (NaN/Infinity) or malformed vector",
        "Check the joint positions, target and pole for NaN before solving.",
      ),
    );
    return problems;
  }
  for (let i = 0; i + 1 < joints.length; i++) {
    if (distance(joints[i]!, joints[i + 1]!) < IK_MIN_BONE_LENGTH) {
      problems.push(
        error(
          "ik.solve.zero-length-bone",
          `Bone ${i} (joint ${i} -> ${i + 1}) has zero length`,
          "Two consecutive joints share a position; exclude helper bones from the chain.",
        ),
      );
    }
  }
  problems.push(...validateNumericOptions(options.tolerance, options.maxIterations, options.weight, "ik.solve"));
  return problems.length > 0 ? problems : undefined;
}

function failure(positions: IkVec3[], diagnostics: IkDiagnostic[]): IkSolveResult {
  return {
    success: false,
    positions,
    reachable: false,
    converged: false,
    iterations: 0,
    error: Number.NaN,
    diagnostics,
  };
}

function isFiniteVec3(v: unknown): v is IkVec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

function error(code: string, message: string, remediation: string): IkDiagnostic {
  return { code, severity: "error", message, remediation };
}
function warning(code: string, message: string, remediation: string): IkDiagnostic {
  return { code, severity: "warning", message, remediation };
}
function info(code: string, message: string, remediation: string): IkDiagnostic {
  return { code, severity: "info", message, remediation };
}

function round(value: number): string {
  return value.toFixed(4);
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function copy(v: IkVec3): IkVec3 {
  return Array.isArray(v) ? [v[0], v[1], v[2]] : v;
}
function set(out: [number, number, number], v: IkVec3): void {
  out[0] = v[0];
  out[1] = v[1];
  out[2] = v[2];
}
function add(a: IkVec3, b: IkVec3): IkVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: IkVec3, b: IkVec3): IkVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: IkVec3, s: number): IkVec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: IkVec3, b: IkVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: IkVec3, b: IkVec3): IkVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: IkVec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function distance(a: IkVec3, b: IkVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function lerp(a: IkVec3, b: IkVec3, t: number): IkVec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function normalizeOr(a: IkVec3, fallback: IkVec3): IkVec3 {
  const l = length(a);
  return l > EPSILON ? scale(a, 1 / l) : fallback;
}
