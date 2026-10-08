/**
 * Seeded property tests for the pure animation contracts (blend space, IK,
 * morph targets). Every case is generated from a fixed seed so failures are
 * reproducible: the failing seed and case index are part of the message.
 * No third-party property-testing library is used.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMorphWeight,
  buildMorphTargetCatalog,
  computeBoneAimRotations,
  evaluateBlendSpace1D,
  evaluateBlendSpace2D,
  rotateVectorByQuat,
  solveFabrikIk,
  solveTwoBoneIk,
  validateMorphWeightRequest,
  type BlendSpace1DDefinition,
  type BlendSpace2DDefinition,
  type BlendSpaceWeight,
  type IkVec3,
  type MorphTargetMeshDescriptor,
} from "../src/index.js";

const SEED = 0x6b696e65; // "kine"
const CASES = 200;

/** mulberry32: tiny deterministic PRNG, good enough for test-case generation. */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function forAll(name: string, body: (rng: () => number, index: number) => void, seed = SEED, cases = CASES): void {
  const rng = createRng(seed);
  for (let index = 0; index < cases; index++) {
    try {
      body(rng, index);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`property "${name}" failed at case ${index} (seed 0x${seed.toString(16)}): ${message}`, { cause });
    }
  }
}

function range(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}
function int(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}
function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
function sum(weights: readonly BlendSpaceWeight[]): number {
  return weights.reduce((total, w) => total + w.weight, 0);
}
function asMap(weights: readonly BlendSpaceWeight[]): Map<string, number> {
  return new Map(weights.map((w) => [w.clipId, w.weight]));
}
function assertSameWeights(a: readonly BlendSpaceWeight[], b: readonly BlendSpaceWeight[], tolerance: number): void {
  const ma = asMap(a);
  const mb = asMap(b);
  for (const clip of new Set([...ma.keys(), ...mb.keys()])) {
    const wa = ma.get(clip) ?? 0;
    const wb = mb.get(clip) ?? 0;
    assert.ok(Math.abs(wa - wb) <= tolerance, `clip ${clip}: ${wa} vs ${wb}`);
  }
}
function assertWellFormedWeights(weights: readonly BlendSpaceWeight[]): void {
  assert.ok(weights.length > 0, "blend space produced no weights");
  assert.ok(Math.abs(sum(weights) - 1) < 1e-9, `weights sum to ${sum(weights)}`);
  const seen = new Set<string>();
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    assert.ok(Number.isFinite(w.weight) && w.weight > 0 && w.weight <= 1 + 1e-12, `weight ${w.weight} out of (0, 1]`);
    assert.ok(!seen.has(w.clipId), `clip ${w.clipId} listed twice`);
    seen.add(w.clipId);
    if (i > 0) assert.ok(weights[i - 1]!.weight >= w.weight, "weights are not sorted descending");
  }
}

function random1D(rng: () => number): BlendSpace1DDefinition {
  const count = int(rng, 1, 7);
  const positions = new Set<number>();
  while (positions.size < count) positions.add(Math.round(range(rng, -10, 10) * 1000) / 1000);
  return {
    schemaVersion: 1,
    kind: "1d",
    id: "prop1d",
    parameter: "speed",
    samples: [...positions].map((position, i) => ({ clipId: `clip${i}`, position })),
  };
}

function random2D(rng: () => number): BlendSpace2DDefinition {
  const count = int(rng, 1, 8);
  const keys = new Set<string>();
  const samples: BlendSpace2DDefinition["samples"] = [];
  while (samples.length < count) {
    const x = Math.round(range(rng, -3, 3) * 100) / 100;
    const y = Math.round(range(rng, -3, 3) * 100) / 100;
    const key = `${x},${y}`;
    if (keys.has(key)) continue;
    keys.add(key);
    samples.push({ clipId: `clip${samples.length}`, position: [x, y] });
  }
  return { schemaVersion: 1, kind: "2d", id: "prop2d", parameters: ["vx", "vz"], samples };
}

// ---------------------------------------------------------------------------
// Blend space 1D
// ---------------------------------------------------------------------------

test("property: 1D weights are a normalized, sorted, at-most-two-clip blend for any input", () => {
  forAll("1d-well-formed", (rng) => {
    const space = random1D(rng);
    const value = range(rng, -15, 15);
    const weights = evaluateBlendSpace1D(space, value);
    assertWellFormedWeights(weights);
    assert.ok(weights.length <= 2, `got ${weights.length} clips`);
  });
});

test("property: 1D blend reconstructs the input position inside the sample range", () => {
  forAll("1d-reconstruct", (rng) => {
    const space = random1D(rng);
    const positions = space.samples.map((s) => s.position);
    const min = Math.min(...positions);
    const max = Math.max(...positions);
    const value = range(rng, min, max);
    const byClip = new Map(space.samples.map((s) => [s.clipId, s.position]));
    const reconstructed = evaluateBlendSpace1D(space, value).reduce((acc, w) => acc + w.weight * byClip.get(w.clipId)!, 0);
    // Weights below BLEND_SPACE_WEIGHT_EPSILON are dropped, so allow that much slack per unit of range.
    assert.ok(Math.abs(reconstructed - value) <= 1e-5 * Math.max(1, max - min), `${reconstructed} vs ${value}`);
  });
});

test("property: 1D blend is exact on samples, clamped outside, and independent of sample order", () => {
  forAll("1d-exact-clamp-order", (rng) => {
    const space = random1D(rng);
    const sample = space.samples[int(rng, 0, space.samples.length - 1)]!;
    assert.deepEqual(evaluateBlendSpace1D(space, sample.position), [{ clipId: sample.clipId, weight: 1 }]);

    const sorted = [...space.samples].sort((a, b) => a.position - b.position);
    assert.deepEqual(evaluateBlendSpace1D(space, sorted[0]!.position - range(rng, 0.001, 100)), [{ clipId: sorted[0]!.clipId, weight: 1 }]);
    assert.deepEqual(evaluateBlendSpace1D(space, sorted.at(-1)!.position + range(rng, 0.001, 100)), [{ clipId: sorted.at(-1)!.clipId, weight: 1 }]);

    const value = range(rng, -12, 12);
    const permuted: BlendSpace1DDefinition = { ...space, samples: shuffled(rng, space.samples) };
    assert.deepEqual(evaluateBlendSpace1D(permuted, value), evaluateBlendSpace1D(space, value));
  });
});

test("property: 1D blend does not mutate its definition", () => {
  forAll("1d-pure", (rng) => {
    const space = random1D(rng);
    const snapshot = structuredClone(space);
    evaluateBlendSpace1D(space, range(rng, -12, 12));
    assert.deepEqual(space, snapshot);
  });
});

// ---------------------------------------------------------------------------
// Blend space 2D
// ---------------------------------------------------------------------------

test("property: 2D weights are normalized, sorted and finite for any input", () => {
  forAll("2d-well-formed", (rng) => {
    const space = random2D(rng);
    const weights = evaluateBlendSpace2D(space, range(rng, -6, 6), range(rng, -6, 6));
    assertWellFormedWeights(weights);
  });
});

test("property: 2D blend gives full weight to a sample when queried exactly on it", () => {
  forAll("2d-exact", (rng) => {
    const space = random2D(rng);
    const sample = space.samples[int(rng, 0, space.samples.length - 1)]!;
    const weights = evaluateBlendSpace2D(space, sample.position[0], sample.position[1]);
    assert.equal(weights[0]!.clipId, sample.clipId);
    assert.ok(Math.abs(weights[0]!.weight - 1) < 1e-9, `weight ${weights[0]!.weight}`);
  });
});

test("property: 2D blend is invariant to sample order and to translating the whole space", () => {
  forAll("2d-invariance", (rng) => {
    const space = random2D(rng);
    const x = range(rng, -5, 5);
    const y = range(rng, -5, 5);
    const base = evaluateBlendSpace2D(space, x, y);

    const permuted: BlendSpace2DDefinition = { ...space, samples: shuffled(rng, space.samples) };
    assertSameWeights(evaluateBlendSpace2D(permuted, x, y), base, 1e-9);

    const dx = range(rng, -20, 20);
    const dy = range(rng, -20, 20);
    const moved: BlendSpace2DDefinition = {
      ...space,
      samples: space.samples.map((s) => ({ clipId: s.clipId, position: [s.position[0] + dx, s.position[1] + dy] as const })),
    };
    assertSameWeights(evaluateBlendSpace2D(moved, x + dx, y + dy), base, 1e-6);
  });
});

test("property: 2D blend is invariant to uniform scaling of samples and input", () => {
  forAll("2d-scale", (rng) => {
    const space = random2D(rng);
    const x = range(rng, -5, 5);
    const y = range(rng, -5, 5);
    const k = range(rng, 0.1, 10);
    const scaled: BlendSpace2DDefinition = {
      ...space,
      samples: space.samples.map((s) => ({ clipId: s.clipId, position: [s.position[0] * k, s.position[1] * k] as const })),
    };
    assertSameWeights(evaluateBlendSpace2D(scaled, x * k, y * k), evaluateBlendSpace2D(space, x, y), 1e-6);
  });
});

// ---------------------------------------------------------------------------
// IK
// ---------------------------------------------------------------------------

function vec(rng: () => number, extent: number): IkVec3 {
  return [range(rng, -extent, extent), range(rng, -extent, extent), range(rng, -extent, extent)];
}
function unit(rng: () => number): IkVec3 {
  for (;;) {
    const v = vec(rng, 1);
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 0.1 && l <= 1) return [v[0] / l, v[1] / l, v[2] / l];
  }
}
function dist(a: IkVec3, b: IkVec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function along(origin: IkVec3, direction: IkVec3, length: number): IkVec3 {
  return [origin[0] + direction[0] * length, origin[1] + direction[1] * length, origin[2] + direction[2] * length];
}
function randomChain(rng: () => number, joints: number): { positions: IkVec3[]; lengths: number[] } {
  const positions: IkVec3[] = [vec(rng, 2)];
  const lengths: number[] = [];
  for (let i = 1; i < joints; i++) {
    const l = range(rng, 0.2, 1.5);
    lengths.push(l);
    positions.push(along(positions[i - 1]!, unit(rng), l));
  }
  return { positions, lengths };
}
function assertLengthsPreserved(positions: readonly IkVec3[], lengths: readonly number[], tolerance: number): void {
  for (let i = 0; i < lengths.length; i++) {
    const actual = dist(positions[i]!, positions[i + 1]!);
    assert.ok(Math.abs(actual - lengths[i]!) <= tolerance, `bone ${i}: ${actual} vs ${lengths[i]}`);
  }
}

test("property: two-bone IK keeps the root fixed and both bone lengths exact for any target", () => {
  forAll("two-bone-lengths", (rng) => {
    const { positions, lengths } = randomChain(rng, 3);
    const target = vec(rng, 5);
    const pole = rng() < 0.5 ? vec(rng, 5) : undefined;
    const result = solveTwoBoneIk(positions[0]!, positions[1]!, positions[2]!, target, { pole });
    assert.equal(result.success, true);
    assert.deepEqual(result.positions[0], positions[0]);
    assertLengthsPreserved(result.positions, lengths, 1e-9);
    for (const p of result.positions) assert.ok(p.every(Number.isFinite));
  });
});

test("property: two-bone IK reaches every target strictly inside its reach annulus", () => {
  forAll("two-bone-reach", (rng) => {
    const { positions, lengths } = randomChain(rng, 3);
    const minReach = Math.abs(lengths[0]! - lengths[1]!);
    const maxReach = lengths[0]! + lengths[1]!;
    const reach = range(rng, minReach + 0.01 * maxReach, maxReach * 0.99);
    const target = along(positions[0]!, unit(rng), reach);
    const result = solveTwoBoneIk(positions[0]!, positions[1]!, positions[2]!, target);
    assert.equal(result.reachable, true);
    assert.equal(result.converged, true);
    assert.ok(result.error < 1e-6, `error ${result.error}`);
  });
});

test("property: two-bone IK extends straight along the root->target line when out of reach", () => {
  forAll("two-bone-out-of-reach", (rng) => {
    const { positions, lengths } = randomChain(rng, 3);
    const maxReach = lengths[0]! + lengths[1]!;
    const direction = unit(rng);
    const target = along(positions[0]!, direction, maxReach * range(rng, 1.05, 4));
    const result = solveTwoBoneIk(positions[0]!, positions[1]!, positions[2]!, target);
    assert.equal(result.reachable, false);
    assert.ok(result.diagnostics.some((d) => d.code === "ik.solve.out-of-reach"));
    const expectedEnd = along(positions[0]!, direction, maxReach);
    assert.ok(dist(result.positions[2]!, expectedEnd) < 1e-6, `end ${dist(result.positions[2]!, expectedEnd)} off the line`);
  });
});

test("property: two-bone IK with weight 0 leaves the end effector where it was", () => {
  forAll("two-bone-weight-zero", (rng) => {
    const { positions } = randomChain(rng, 3);
    const result = solveTwoBoneIk(positions[0]!, positions[1]!, positions[2]!, vec(rng, 5), { weight: 0 });
    assert.ok(dist(result.positions[2]!, positions[2]!) < 1e-6, `end moved ${dist(result.positions[2]!, positions[2]!)}`);
  });
});

test("property: FABRIK keeps the root fixed, preserves bone lengths and is deterministic", () => {
  forAll("fabrik-lengths", (rng) => {
    const { positions, lengths } = randomChain(rng, int(rng, 2, 7));
    const target = vec(rng, 6);
    const result = solveFabrikIk(positions, target);
    assert.equal(result.success, true);
    assert.deepEqual(result.positions[0], positions[0]);
    assertLengthsPreserved(result.positions, lengths, 1e-9);
    assert.deepEqual(solveFabrikIk(positions, target), result);
    assert.ok(result.iterations <= 16);
  });
});

test("property: FABRIK converges on reachable targets given a generous iteration budget", () => {
  forAll("fabrik-converge", (rng) => {
    const { positions, lengths } = randomChain(rng, int(rng, 3, 6));
    const total = lengths.reduce((a, b) => a + b, 0);
    const longest = Math.max(...lengths);
    const minReach = Math.max(0, 2 * longest - total);
    // FABRIK converges slowly for targets very close to the root or at the
    // full-extension boundary (a known property of the algorithm), so sample
    // the well-conditioned band. 40k cases across 8 seeds converge here.
    const reach = range(rng, Math.max(minReach + 0.1 * total, 0.3 * total), total * 0.9);
    const target = along(positions[0]!, unit(rng), reach);
    const result = solveFabrikIk(positions, target, { maxIterations: 512, tolerance: 1e-4 });
    assert.equal(result.reachable, true);
    assert.equal(result.converged, true, `error ${result.error} after ${result.iterations} iterations`);
  });
});

test("property: FABRIK never leaves the end effector farther from a reachable target than it started", () => {
  forAll("fabrik-no-regression", (rng) => {
    const { positions, lengths } = randomChain(rng, int(rng, 2, 7));
    const total = lengths.reduce((a, b) => a + b, 0);
    const target = vec(rng, 6);
    if (dist(positions[0]!, target) > total) return;
    const result = solveFabrikIk(positions, target);
    assert.ok(result.error <= dist(positions.at(-1)!, target) + 1e-9, `error grew to ${result.error}`);
  });
});

test("property: computeBoneAimRotations returns unit quaternions that map each before-bone onto its after-bone", () => {
  forAll("aim-rotations", (rng) => {
    const { positions } = randomChain(rng, int(rng, 2, 6));
    const target = vec(rng, 6);
    const solved = solveFabrikIk(positions, target).positions;
    const rotations = computeBoneAimRotations(positions, solved);
    assert.equal(rotations.length, positions.length - 1);
    for (let i = 0; i < rotations.length; i++) {
      const q = rotations[i]!;
      assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-9, `|q| = ${Math.hypot(...q)}`);
      const before = positions[i + 1]!.map((c, k) => c - positions[i]![k]!) as unknown as IkVec3;
      const after = solved[i + 1]!.map((c, k) => c - solved[i]![k]!) as unknown as IkVec3;
      const rotated = rotateVectorByQuat(before, q);
      const lb = Math.hypot(...before);
      const la = Math.hypot(...after);
      const diff = dist([rotated[0] / lb, rotated[1] / lb, rotated[2] / lb], [after[0] / la, after[1] / la, after[2] / la]);
      assert.ok(diff < 1e-7, `bone ${i} misaligned by ${diff}`);
    }
  });
});

test("property: computeBoneAimRotations handles exactly opposite bone directions", () => {
  forAll("aim-opposite", (rng) => {
    const root = vec(rng, 2);
    const d = unit(rng);
    const before: IkVec3[] = [root, along(root, d, 1)];
    const after: IkVec3[] = [root, along(root, d, -1)];
    const [q] = computeBoneAimRotations(before, after);
    assert.ok(Math.abs(Math.hypot(...q!) - 1) < 1e-9);
    const rotated = rotateVectorByQuat(d, q!);
    assert.ok(dist(rotated, [-d[0], -d[1], -d[2]]) < 1e-7, `opposite rotation off by ${dist(rotated, [-d[0], -d[1], -d[2]])}`);
  });
});

// ---------------------------------------------------------------------------
// Morph targets
// ---------------------------------------------------------------------------

const MORPH_NAMES = ["blink", "smile", "jawOpen", "browUp", "Blink", "frown"];

function randomMeshes(rng: () => number): MorphTargetMeshDescriptor[] {
  const meshCount = int(rng, 1, 4);
  const meshes: MorphTargetMeshDescriptor[] = [];
  for (let m = 0; m < meshCount; m++) {
    const names = shuffled(rng, MORPH_NAMES).slice(0, int(rng, 0, MORPH_NAMES.length));
    meshes.push({ meshName: `mesh${m}`, targetNames: names, influences: names.map(() => 0) });
  }
  return meshes;
}

test("property: morph catalog binds every named slot exactly once, with names sorted and unique", () => {
  forAll("morph-catalog", (rng) => {
    const meshes = randomMeshes(rng);
    const catalog = buildMorphTargetCatalog(meshes);
    assert.deepEqual(catalog.names, [...new Set(catalog.names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const expectedSlots = meshes.reduce((n, mesh) => n + mesh.targetNames.length, 0);
    const boundSlots = [...catalog.bindings.values()].reduce((n, list) => n + list.length, 0);
    assert.equal(boundSlots, expectedSlots);
    for (const [name, list] of catalog.bindings) {
      for (const { meshIndex, influenceIndex } of list) assert.equal(meshes[meshIndex]!.targetNames[influenceIndex], name);
    }
  });
});

test("property: valid morph requests apply to exactly the bound slots and nothing else", () => {
  forAll("morph-apply", (rng) => {
    const meshes = randomMeshes(rng);
    const catalog = buildMorphTargetCatalog(meshes);
    if (catalog.names.length === 0) return;
    const request: Record<string, number> = {};
    for (const name of shuffled(rng, catalog.names).slice(0, int(rng, 1, catalog.names.length))) request[name] = rng();
    const validated = validateMorphWeightRequest(request, catalog);
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const influences = meshes.map((mesh) => [...mesh.influences]);
    for (const update of validated.value) {
      assert.equal(applyMorphWeight(catalog, influences, update.name, update.weight), catalog.bindings.get(update.name)!.length);
    }
    meshes.forEach((mesh, m) => {
      mesh.targetNames.forEach((name, i) => {
        assert.equal(influences[m]![i], name in request ? request[name] : 0);
      });
    });
  });
});

test("property: one bad entry rejects the whole morph request", () => {
  forAll("morph-all-or-nothing", (rng) => {
    const meshes = randomMeshes(rng);
    const catalog = buildMorphTargetCatalog(meshes);
    if (catalog.names.length === 0) return;
    const request: Record<string, unknown> = {};
    for (const name of catalog.names) request[name] = rng();
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.0001, "0.5", null][int(rng, 0, 5)];
    const victim = catalog.names[int(rng, 0, catalog.names.length - 1)]!;
    const unknownName = "notATarget";
    if (rng() < 0.5) request[victim] = bad;
    else request[unknownName] = 0.5;
    const validated = validateMorphWeightRequest(request, catalog);
    assert.equal(validated.ok, false);
    if (!validated.ok) {
      assert.equal(validated.diagnostics.length, 1);
      const expected = unknownName in request ? "anim.morph.unknownTarget" : typeof bad === "number" && Number.isFinite(bad) ? "anim.morph.weightOutOfRange" : "anim.morph.weightNotFinite";
      assert.equal(validated.diagnostics[0]!.code, expected);
    }
  });
});
