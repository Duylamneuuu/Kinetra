import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  IK_MAX_ITERATIONS_LIMIT,
  computeBoneAimRotations,
  rotateVectorByQuat,
  solveFabrikIk,
  solveIkChain,
  solveTwoBoneIk,
  validateIkChainDefinition,
  type IkChainDefinition,
  type IkVec3,
} from "../src/ik.js";

const dist = (a: IkVec3, b: IkVec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const near = (actual: number, expected: number, eps = 1e-6, label = "") =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} expected ${expected}, got ${actual}`);
const nearVec = (actual: IkVec3, expected: IkVec3, eps = 1e-6, label = "") =>
  assert.ok(dist(actual, expected) <= eps, `${label} expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
const codes = (diagnostics: { code: string }[]) => diagnostics.map((d) => d.code);

// A straight leg hanging down: hip (0,1,0) -> knee (0,0.5,0) -> ankle (0,0,0).
const HIP: IkVec3 = [0, 1, 0];
const KNEE: IkVec3 = [0, 0.5, 0];
const ANKLE: IkVec3 = [0, 0, 0];
// Slightly pre-bent leg (knee forward in +Z), the usual authored rest pose.
const KNEE_BENT: IkVec3 = [0, 0.5, 0.05];
const ANKLE_BENT: IkVec3 = [0, 0, 0];

const LEG: IkChainDefinition = {
  schemaVersion: 1,
  id: "leftLeg",
  solver: "two-bone",
  joints: ["LeftUpLeg", "LeftLeg", "LeftFoot"],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("IK validation: well-formed two-bone and fabrik chains have no diagnostics", () => {
  assert.deepEqual(validateIkChainDefinition(LEG), []);
  assert.deepEqual(
    validateIkChainDefinition({
      schemaVersion: 1,
      id: "tail",
      solver: "fabrik",
      joints: ["Tail0", "Tail1", "Tail2", "Tail3", "Tail4"],
      tolerance: 0.001,
      maxIterations: 32,
      weight: 0.5,
    }),
    [],
  );
});

test("IK validation: reports every structural problem with codes and remediation", () => {
  const diagnostics = validateIkChainDefinition({
    schemaVersion: 2 as 1,
    id: " ",
    solver: "ccd" as "fabrik",
    joints: ["A", "", "A"],
    tolerance: 0,
    maxIterations: 2.5,
    weight: 1.5,
  });
  assert.deepEqual(codes(diagnostics), [
    "ik.chain.schema.unsupported",
    "ik.chain.id.empty",
    "ik.chain.solver.unknown",
    "ik.chain.joint.empty",
    "ik.chain.joint.duplicate",
    "ik.chain.tolerance.invalid",
    "ik.chain.iterations.invalid",
    "ik.chain.weight.invalid",
  ]);
  for (const d of diagnostics) {
    assert.equal(d.severity, "error");
    assert.ok(d.message.length > 0 && d.remediation.length > 0, `${d.code} needs message and remediation`);
  }
});

test("IK validation: joint-count rules per solver and malformed input never throws", () => {
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, joints: ["A", "B"] })), ["ik.chain.joints.two-bone-count"]);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, solver: "fabrik", joints: ["A"] })), [
    "ik.chain.joints.too-few",
  ]);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, joints: ["A"] })), [
    "ik.chain.joints.too-few",
    "ik.chain.joints.two-bone-count",
  ]);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, joints: undefined as unknown as string[] })), [
    "ik.chain.joints.missing",
  ]);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, joints: ["A", 3 as unknown as string, "C"] })), [
    "ik.chain.joint.empty",
  ]);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, maxIterations: IK_MAX_ITERATIONS_LIMIT + 1 })), [
    "ik.chain.iterations.invalid",
  ]);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, maxIterations: IK_MAX_ITERATIONS_LIMIT })), []);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, weight: Number.NaN })), ["ik.chain.weight.invalid"]);
  assert.deepEqual(codes(validateIkChainDefinition({ ...LEG, tolerance: Number.POSITIVE_INFINITY })), [
    "ik.chain.tolerance.invalid",
  ]);
});

// ---------------------------------------------------------------------------
// Two-bone
// ---------------------------------------------------------------------------

test("Two-bone IK: reachable target is hit exactly with bone lengths preserved", () => {
  const target: IkVec3 = [0.2, 0.3, 0.1];
  const result = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, target);
  assert.equal(result.success, true);
  assert.equal(result.reachable, true);
  assert.equal(result.converged, true);
  assert.deepEqual(result.diagnostics, []);
  const [hip, knee, ankle] = result.positions as [IkVec3, IkVec3, IkVec3];
  nearVec(hip, HIP, 0, "root fixed");
  nearVec(ankle, target, 1e-9, "end effector");
  near(dist(hip, knee), dist(HIP, KNEE_BENT), 1e-9, "upper length");
  near(dist(knee, ankle), dist(KNEE_BENT, ANKLE_BENT), 1e-9, "lower length");
  near(result.error, 0, 1e-9, "error");
});

test("Two-bone IK: knee bends towards the existing bend plane, and the pole overrides it", () => {
  const target: IkVec3 = [0, 0.4, 0];
  const natural = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, target);
  assert.ok(natural.positions[1]![2] > 0.1, "knee keeps bending forward (+Z) without a pole");
  near(natural.positions[1]![0], 0, 1e-9, "knee stays in the original YZ plane");

  const poled = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, target, { pole: [1, 0.5, 0] });
  assert.ok(poled.positions[1]![0] > 0.1, "knee follows the pole to +X");
  near(poled.positions[1]![2], 0, 1e-9, "knee leaves the Z bend plane");
  nearVec(poled.positions[2]!, target, 1e-9, "pole does not change the reached point");
  assert.deepEqual(poled.diagnostics, []);
});

test("Two-bone IK: out-of-reach target straightens the limb towards it without stretching", () => {
  const target: IkVec3 = [0, 1, 5];
  const result = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, target);
  assert.equal(result.success, true);
  assert.equal(result.reachable, false);
  assert.equal(result.converged, false);
  assert.deepEqual(codes(result.diagnostics), ["ik.solve.out-of-reach"]);
  assert.equal(result.diagnostics[0]!.severity, "info");
  const reach = dist(HIP, KNEE_BENT) + dist(KNEE_BENT, ANKLE_BENT);
  nearVec(result.positions[2]!, [0, 1, reach], 1e-6, "fully extended along +Z");
  near(result.error, 5 - reach, 1e-6, "error is the remaining gap");
  near(dist(result.positions[0]!, result.positions[1]!), dist(HIP, KNEE_BENT), 1e-9);
  near(dist(result.positions[1]!, result.positions[2]!), dist(KNEE_BENT, ANKLE_BENT), 1e-9);
});

test("Two-bone IK: target inside minimum reach of an unequal limb folds it fully", () => {
  // upper 0.6, lower 0.2 -> min reach 0.4
  const root: IkVec3 = [0, 0, 0];
  const mid: IkVec3 = [0.6, 0, 0];
  const end: IkVec3 = [0.6, 0.2, 0];
  const result = solveTwoBoneIk(root, mid, end, [0.1, 0, 0]);
  assert.equal(result.reachable, false);
  assert.deepEqual(codes(result.diagnostics), ["ik.solve.inside-min-reach"]);
  near(dist(root, result.positions[2]!), 0.4, 1e-9, "folded to minimum reach");
  near(dist(result.positions[0]!, result.positions[1]!), 0.6, 1e-9);
  near(dist(result.positions[1]!, result.positions[2]!), 0.2, 1e-9);
});

test("Two-bone IK: straight limb, colinear pole and target-at-root are handled deterministically", () => {
  // Perfectly straight limb aimed at a closer point on the same line: no bend plane info.
  const a = solveTwoBoneIk(HIP, KNEE, ANKLE, [0, 0.2, 0]);
  const b = solveTwoBoneIk(HIP, KNEE, ANKLE, [0, 0.2, 0]);
  assert.deepEqual(a, b, "deterministic");
  assert.equal(a.success, true);
  nearVec(a.positions[2]!, [0, 0.2, 0], 1e-9);
  near(dist(a.positions[0]!, a.positions[1]!), 0.5, 1e-9);

  const colinearPole = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, [0, 0.4, 0], { pole: [0, -3, 0] });
  assert.deepEqual(codes(colinearPole.diagnostics), ["ik.solve.pole-degenerate"]);
  assert.ok(colinearPole.positions[1]![2] > 0.1, "falls back to the existing bend plane");

  const atRoot = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, HIP);
  assert.equal(atRoot.success, true);
  assert.ok(codes(atRoot.diagnostics).includes("ik.solve.target-at-root"));
  for (const p of atRoot.positions) assert.ok(p.every(Number.isFinite), "no NaN on degenerate input");
});

test("Two-bone IK: weight blends the goal between the current pose and the target", () => {
  const target: IkVec3 = [0.3, 0.4, 0.2];
  const zero = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, target, { weight: 0 });
  nearVec(zero.positions[1]!, KNEE_BENT, 1e-9, "weight 0 keeps the knee");
  nearVec(zero.positions[2]!, ANKLE_BENT, 1e-9, "weight 0 keeps the ankle");

  const half = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, target, { weight: 0.5 });
  nearVec(half.positions[2]!, [0.15, 0.2, 0.1], 1e-9, "weight 0.5 reaches the midpoint");
});

test("Two-bone IK: rejects malformed input without throwing and without mutating it", () => {
  const root: [number, number, number] = [0, 1, 0];
  const mid: [number, number, number] = [0, 0.5, 0.05];
  const end: [number, number, number] = [0, 0, 0];
  const snapshot = JSON.stringify([root, mid, end]);
  solveTwoBoneIk(root, mid, end, [0.2, 0.3, 0.1]);
  assert.equal(JSON.stringify([root, mid, end]), snapshot, "inputs are not mutated");

  const nan = solveTwoBoneIk(root, mid, end, [Number.NaN, 0, 0]);
  assert.equal(nan.success, false);
  assert.deepEqual(codes(nan.diagnostics), ["ik.solve.non-finite"]);
  assert.equal(JSON.stringify(nan.positions), snapshot, "failure returns the input pose");

  assert.deepEqual(codes(solveTwoBoneIk(root, mid, end, [0, 0, 0], { pole: [0, Infinity, 0] }).diagnostics), [
    "ik.solve.non-finite",
  ]);
  assert.deepEqual(codes(solveTwoBoneIk(root, root, end, [0, 0, 0]).diagnostics), ["ik.solve.zero-length-bone"]);
  assert.deepEqual(codes(solveTwoBoneIk(root, mid, end, [0, 0, 0], { weight: -1 }).diagnostics), [
    "ik.solve.weight.invalid",
  ]);
  assert.deepEqual(
    codes(solveTwoBoneIk(root, mid, [0, 0] as unknown as IkVec3, [0, 0, 0]).diagnostics),
    ["ik.solve.non-finite"],
  );
});

// ---------------------------------------------------------------------------
// FABRIK
// ---------------------------------------------------------------------------

const TAIL: IkVec3[] = [
  [0, 0, 0],
  [0, 0, -0.25],
  [0, 0, -0.5],
  [0, 0, -0.75],
  [0, 0, -1],
];

function boneLengths(points: readonly IkVec3[]): number[] {
  return points.slice(1).map((p, i) => dist(points[i]!, p));
}

test("FABRIK: converges on a reachable target with root fixed and lengths preserved", () => {
  const target: IkVec3 = [0.4, 0.3, -0.5];
  const result = solveFabrikIk(TAIL, target, { tolerance: 1e-5, maxIterations: 64 });
  assert.equal(result.success, true);
  assert.equal(result.reachable, true);
  assert.equal(result.converged, true);
  assert.ok(result.iterations >= 1 && result.iterations <= 64);
  assert.ok(result.error <= 1e-5, `error ${result.error}`);
  nearVec(result.positions[0]!, TAIL[0]!, 0, "root pinned");
  nearVec(result.positions.at(-1)!, target, 1e-5, "end effector");
  boneLengths(result.positions).forEach((l, i) => near(l, 0.25, 1e-9, `bone ${i}`));
  assert.deepEqual(result.diagnostics, []);
});

test("FABRIK: already-solved chain does zero iterations; result is deterministic", () => {
  const solved = solveFabrikIk(TAIL, TAIL.at(-1)!);
  assert.equal(solved.iterations, 0);
  assert.equal(solved.converged, true);
  assert.deepEqual(solved.positions, TAIL);

  const target: IkVec3 = [-0.2, 0.5, -0.3];
  assert.deepEqual(solveFabrikIk(TAIL, target), solveFabrikIk(TAIL, target));
});

test("FABRIK: unreachable target straightens the chain along the root->target line", () => {
  const target: IkVec3 = [0, 3, 0];
  const result = solveFabrikIk(TAIL, target);
  assert.equal(result.reachable, false);
  assert.equal(result.converged, false);
  assert.equal(result.iterations, 0);
  assert.deepEqual(codes(result.diagnostics), ["ik.solve.out-of-reach"]);
  result.positions.forEach((p, i) => nearVec(p, [0, 0.25 * i, 0], 1e-9, `joint ${i}`));
  near(result.error, 2, 1e-9);
});

test("FABRIK: tight iteration budget reports not-converged as a warning", () => {
  const result = solveFabrikIk(TAIL, [0.6, 0.6, 0.2], { maxIterations: 1, tolerance: 1e-9 });
  assert.equal(result.success, true);
  assert.equal(result.iterations, 1);
  assert.equal(result.converged, false);
  assert.deepEqual(codes(result.diagnostics), ["ik.solve.not-converged"]);
  assert.equal(result.diagnostics[0]!.severity, "warning");
  boneLengths(result.positions).forEach((l) => near(l, 0.25, 1e-9));
});

test("FABRIK: two-joint chain and a target on the root keep finite, length-preserving output", () => {
  const single = solveFabrikIk([[0, 0, 0], [1, 0, 0]], [0, 2, 0]);
  nearVec(single.positions[1]!, [0, 1, 0], 1e-9, "single bone aims at target");

  const folded = solveFabrikIk(TAIL, [0, 0, 0], { maxIterations: 32 });
  assert.equal(folded.success, true);
  for (const p of folded.positions) assert.ok(p.every(Number.isFinite));
  boneLengths(folded.positions).forEach((l) => near(l, 0.25, 1e-9));
  nearVec(folded.positions[0]!, [0, 0, 0], 0);
});

test("FABRIK: rejects malformed input with structured errors", () => {
  assert.deepEqual(codes(solveFabrikIk([[0, 0, 0]], [1, 0, 0]).diagnostics), ["ik.solve.joint-count"]);
  assert.deepEqual(codes(solveFabrikIk(undefined as unknown as IkVec3[], [1, 0, 0]).diagnostics), [
    "ik.solve.joint-count",
  ]);
  assert.deepEqual(codes(solveFabrikIk([[0, 0, 0], [0, 0, 0], [1, 0, 0]], [1, 0, 0]).diagnostics), [
    "ik.solve.zero-length-bone",
  ]);
  assert.deepEqual(codes(solveFabrikIk(TAIL, [0, 0, 0], { maxIterations: 0, tolerance: -1 }).diagnostics), [
    "ik.solve.tolerance.invalid",
    "ik.solve.iterations.invalid",
  ]);
  const failed = solveFabrikIk(TAIL, [0, Number.NaN, 0]);
  assert.equal(failed.success, false);
  assert.ok(Number.isNaN(failed.error));
  assert.deepEqual(failed.positions, TAIL);
});

// ---------------------------------------------------------------------------
// Chain dispatcher
// ---------------------------------------------------------------------------

test("solveIkChain: dispatches by solver and applies definition defaults with option overrides", () => {
  const leg = solveIkChain(LEG, [HIP, KNEE_BENT, ANKLE_BENT], [0.2, 0.3, 0.1]);
  assert.equal(leg.success, true);
  nearVec(leg.positions[2]!, [0.2, 0.3, 0.1], 1e-9);

  const tail: IkChainDefinition = {
    schemaVersion: 1,
    id: "tail",
    solver: "fabrik",
    joints: ["T0", "T1", "T2", "T3", "T4"],
    maxIterations: 1,
    tolerance: 1e-9,
    weight: 1,
  };
  const limited = solveIkChain(tail, TAIL, [0.6, 0.6, 0.2]);
  assert.equal(limited.iterations, 1, "definition maxIterations applies");
  const overridden = solveIkChain(tail, TAIL, [0.6, 0.6, 0.2], { maxIterations: 200, tolerance: 1e-6 });
  assert.equal(overridden.converged, true, "explicit options override the definition");

  const half = solveIkChain({ ...LEG, weight: 0 }, [HIP, KNEE_BENT, ANKLE_BENT], [1, 1, 1]);
  nearVec(half.positions[2]!, ANKLE_BENT, 1e-9, "definition weight applies");
});

test("solveIkChain: invalid definitions and joint-count mismatch fail without solving", () => {
  const invalid = solveIkChain({ ...LEG, joints: ["A", "A", "B"] }, [HIP, KNEE_BENT, ANKLE_BENT], [0, 0, 0]);
  assert.equal(invalid.success, false);
  assert.deepEqual(codes(invalid.diagnostics), ["ik.chain.joint.duplicate"]);

  const mismatch = solveIkChain(LEG, [HIP, KNEE_BENT], [0, 0, 0]);
  assert.equal(mismatch.success, false);
  assert.deepEqual(codes(mismatch.diagnostics), ["ik.solve.joint-count-mismatch"]);
});

// ---------------------------------------------------------------------------
// Pose conversion
// ---------------------------------------------------------------------------

test("computeBoneAimRotations: rotations map old bone directions onto solved ones and match Three.js", () => {
  const before = [HIP, KNEE_BENT, ANKLE_BENT];
  const result = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, [0.2, 0.3, 0.1]);
  const rotations = computeBoneAimRotations(before, result.positions);
  assert.equal(rotations.length, 2);
  for (let i = 0; i < 2; i++) {
    const q = rotations[i]!;
    near(Math.hypot(...q), 1, 1e-12, "unit quaternion");
    const from = before[i + 1]!.map((v, k) => v - before[i]![k]!) as unknown as IkVec3;
    const to = result.positions[i + 1]!.map((v, k) => v - result.positions[i]![k]!) as unknown as IkVec3;
    const rotated = rotateVectorByQuat(from, q);
    nearVec(rotated, to, 1e-9, `bone ${i}`);

    const threeQ = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(...from).normalize(),
      new THREE.Vector3(...to).normalize(),
    );
    const threeRotated = new THREE.Vector3(...from).applyQuaternion(threeQ);
    nearVec([threeRotated.x, threeRotated.y, threeRotated.z], to, 1e-9, `three.js agrees on bone ${i}`);
  }
});

test("computeBoneAimRotations: identity, 180-degree flips and length mismatch", () => {
  const identity = computeBoneAimRotations(TAIL, TAIL);
  assert.equal(identity.length, 4);
  for (const q of identity) {
    near(Math.hypot(q[0], q[1], q[2]), 0, 1e-12, "no axis");
    near(q[3], 1, 1e-12, "w");
  }

  const flipped = computeBoneAimRotations([[0, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, -1, 0]]);
  near(Math.hypot(...flipped[0]!), 1, 1e-12);
  nearVec(rotateVectorByQuat([0, 1, 0], flipped[0]!), [0, -1, 0], 1e-9, "180-degree flip");

  assert.deepEqual(computeBoneAimRotations([[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [1, 0, 0]]), [[0, 0, 0, 1]]);
  assert.throws(() => computeBoneAimRotations(TAIL, TAIL.slice(1)), RangeError);
  assert.deepEqual(computeBoneAimRotations([], []), []);
});

test("Two-bone IK + aim rotations: randomized property sweep stays finite and length-exact", () => {
  // Deterministic LCG so the sweep is reproducible.
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let n = 0; n < 500; n++) {
    const target: IkVec3 = [rand() * 3 - 1.5, rand() * 3 - 1.5, rand() * 3 - 1.5];
    const pole: IkVec3 | undefined = n % 2 === 0 ? [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1] : undefined;
    const result = solveTwoBoneIk(HIP, KNEE_BENT, ANKLE_BENT, target, { pole });
    assert.equal(result.success, true);
    for (const p of result.positions) assert.ok(p.every(Number.isFinite), `finite at ${n}`);
    near(dist(result.positions[0]!, result.positions[1]!), dist(HIP, KNEE_BENT), 1e-9, `upper ${n}`);
    near(dist(result.positions[1]!, result.positions[2]!), dist(KNEE_BENT, ANKLE_BENT), 1e-9, `lower ${n}`);
    if (result.reachable) near(result.error, 0, 1e-7, `reach ${n}`);
    for (const q of computeBoneAimRotations([HIP, KNEE_BENT, ANKLE_BENT], result.positions)) {
      near(Math.hypot(...q), 1, 1e-9, `unit ${n}`);
    }
  }
});
