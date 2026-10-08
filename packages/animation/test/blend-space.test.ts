import assert from "node:assert/strict";
import test from "node:test";

import {
  AnimationGraphMachine,
  evaluateBlendSpace,
  evaluateBlendSpace1D,
  evaluateBlendSpace2D,
  validateBlendSpace,
  type BlendSpace1DDefinition,
  type BlendSpace2DDefinition,
  type BlendSpaceDefinition,
  type BlendSpaceWeight,
} from "../src/index.js";

const locomotion1D: BlendSpace1DDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "locomotion_speed",
  parameter: "speed",
  samples: [
    { clipId: "run", position: 4 },
    { clipId: "idle", position: 0 },
    { clipId: "walk", position: 1.5 },
  ],
};

const strafe2D: BlendSpace2DDefinition = {
  schemaVersion: 1,
  kind: "2d",
  id: "locomotion_strafe",
  parameters: ["velocityX", "velocityZ"],
  samples: [
    { clipId: "idle", position: [0, 0] },
    { clipId: "forward", position: [0, 1] },
    { clipId: "backward", position: [0, -1] },
    { clipId: "left", position: [-1, 0] },
    { clipId: "right", position: [1, 0] },
  ],
};

function weightOf(weights: BlendSpaceWeight[], clipId: string): number {
  return weights.find((w) => w.clipId === clipId)?.weight ?? 0;
}

function sum(weights: BlendSpaceWeight[]): number {
  return weights.reduce((total, w) => total + w.weight, 0);
}

function codes(space: BlendSpaceDefinition): string[] {
  return validateBlendSpace(space).map((d) => d.code);
}

test("valid 1D and 2D blend spaces produce no diagnostics", () => {
  assert.deepEqual(validateBlendSpace(locomotion1D), []);
  assert.deepEqual(validateBlendSpace(strafe2D), []);
});

test("1D blend is exact on samples, linear between neighbours, clamped at the ends", () => {
  assert.deepEqual(evaluateBlendSpace1D(locomotion1D, 0), [{ clipId: "idle", weight: 1 }]);
  assert.deepEqual(evaluateBlendSpace1D(locomotion1D, 1.5), [{ clipId: "walk", weight: 1 }]);
  assert.deepEqual(evaluateBlendSpace1D(locomotion1D, -3), [{ clipId: "idle", weight: 1 }]);
  assert.deepEqual(evaluateBlendSpace1D(locomotion1D, 99), [{ clipId: "run", weight: 1 }]);

  const quarter = evaluateBlendSpace1D(locomotion1D, 0.375);
  assert.equal(quarter.length, 2);
  assert.ok(Math.abs(weightOf(quarter, "idle") - 0.75) < 1e-12);
  assert.ok(Math.abs(weightOf(quarter, "walk") - 0.25) < 1e-12);
  assert.equal(quarter[0]?.clipId, "idle", "heaviest clip comes first");

  const walkRun = evaluateBlendSpace1D(locomotion1D, 2.75);
  assert.ok(Math.abs(weightOf(walkRun, "walk") - 0.5) < 1e-12);
  assert.ok(Math.abs(weightOf(walkRun, "run") - 0.5) < 1e-12);
  assert.equal(weightOf(walkRun, "idle"), 0);
});

test("1D weights are continuous and monotonic across a sweep", () => {
  let previousRun = -1;
  for (let i = 0; i <= 400; i++) {
    const speed = (i / 400) * 5;
    const weights = evaluateBlendSpace1D(locomotion1D, speed);
    assert.ok(Math.abs(sum(weights) - 1) < 1e-9, `sum at ${speed}`);
    const run = weightOf(weights, "run");
    assert.ok(run >= previousRun - 1e-12, `run weight must not drop at ${speed}`);
    previousRun = run;
  }
});

test("2D blend is exact on every sample", () => {
  for (const sample of strafe2D.samples) {
    const weights = evaluateBlendSpace2D(strafe2D, sample.position[0], sample.position[1]);
    assert.deepEqual(weights, [{ clipId: sample.clipId, weight: 1 }], sample.clipId);
  }
});

test("2D blend mixes neighbours, ignores the far side and sums to 1", () => {
  const halfForward = evaluateBlendSpace2D(strafe2D, 0, 0.5);
  assert.ok(Math.abs(weightOf(halfForward, "idle") - 0.5) < 1e-9);
  assert.ok(Math.abs(weightOf(halfForward, "forward") - 0.5) < 1e-9);
  assert.equal(weightOf(halfForward, "backward"), 0);

  const diagonal = evaluateBlendSpace2D(strafe2D, 0.5, 0.5);
  assert.ok(Math.abs(sum(diagonal) - 1) < 1e-9);
  assert.ok(Math.abs(weightOf(diagonal, "forward") - weightOf(diagonal, "right")) < 1e-9, "symmetric diagonal");
  assert.equal(weightOf(diagonal, "left"), 0);
  assert.equal(weightOf(diagonal, "backward"), 0);

  const outside = evaluateBlendSpace2D(strafe2D, 0, 3);
  assert.deepEqual(outside, [{ clipId: "forward", weight: 1 }], "beyond the hull clamps to the nearest edge sample");
});

test("2D weights are deterministic, bounded and normalized over a grid", () => {
  for (let ix = -12; ix <= 12; ix++) {
    for (let iy = -12; iy <= 12; iy++) {
      const x = ix / 8;
      const y = iy / 8;
      const a = evaluateBlendSpace2D(strafe2D, x, y);
      const b = evaluateBlendSpace2D(strafe2D, x, y);
      assert.deepEqual(a, b);
      assert.ok(a.length > 0, `non-empty at ${x},${y}`);
      assert.ok(Math.abs(sum(a) - 1) < 1e-9, `sum at ${x},${y}`);
      for (const w of a) assert.ok(w.weight > 0 && w.weight <= 1 + 1e-12);
    }
  }
});

test("sample order does not change 2D weights", () => {
  const reversed: BlendSpace2DDefinition = { ...strafe2D, samples: [...strafe2D.samples].reverse() };
  assert.deepEqual(evaluateBlendSpace2D(reversed, 0.3, -0.7), evaluateBlendSpace2D(strafe2D, 0.3, -0.7));
});

test("single-sample blend spaces always return that clip", () => {
  const one: BlendSpace2DDefinition = { ...strafe2D, samples: [{ clipId: "idle", position: [0, 0] }] };
  assert.deepEqual(evaluateBlendSpace2D(one, 5, -5), [{ clipId: "idle", weight: 1 }]);
});

test("validation reports structured codes with remediation hints", () => {
  assert.deepEqual(codes({ ...locomotion1D, samples: [] }), ["anim.blendSpace.samples.empty"]);
  assert.deepEqual(codes({ ...locomotion1D, parameter: "" }), ["anim.blendSpace.parameter.empty"]);
  assert.deepEqual(codes({ ...strafe2D, parameters: ["speed", "speed"] }), ["anim.blendSpace.parameter.duplicate"]);
  assert.deepEqual(
    codes({ ...locomotion1D, samples: [{ clipId: "idle", position: 0 }, { clipId: "idle", position: 1 }] }),
    ["anim.blendSpace.sample.clip.duplicate"],
  );
  assert.deepEqual(
    codes({ ...locomotion1D, samples: [{ clipId: "idle", position: 0 }, { clipId: "walk", position: 0 }] }),
    ["anim.blendSpace.sample.position.duplicate"],
  );
  assert.deepEqual(
    codes({ ...locomotion1D, samples: [{ clipId: "idle", position: Number.NaN }] }),
    ["anim.blendSpace.sample.position.invalid"],
  );
  assert.deepEqual(
    codes({ ...strafe2D, samples: [{ clipId: "idle", position: [0] as unknown as [number, number] }] }),
    ["anim.blendSpace.sample.position.invalid"],
  );
  assert.deepEqual(codes({ ...locomotion1D, samples: [{ clipId: "", position: 0 }] }), ["anim.blendSpace.sample.clip.empty"]);
  assert.deepEqual(codes({ ...locomotion1D, schemaVersion: 2 as 1 }), ["anim.blendSpace.schemaVersion"]);
  assert.deepEqual(codes({ ...locomotion1D, kind: "3d" } as unknown as BlendSpaceDefinition), ["anim.blendSpace.kind"]);
  for (const d of validateBlendSpace({ ...locomotion1D, samples: [] })) {
    assert.ok(d.remediation.length > 0);
  }
});

test("evaluation rejects invalid spaces and non-finite input", () => {
  assert.throws(() => evaluateBlendSpace1D({ ...locomotion1D, samples: [] }, 0), /Invalid blend space/);
  assert.throws(() => evaluateBlendSpace1D(locomotion1D, Number.NaN), TypeError);
  assert.throws(() => evaluateBlendSpace2D(strafe2D, 0, Number.POSITIVE_INFINITY), TypeError);
});

test("blend spaces read number parameters from an AnimationGraphMachine", () => {
  const machine = new AnimationGraphMachine({
    schemaVersion: 1,
    entryState: "locomotion",
    parameters: {
      speed: { type: "number", default: 0 },
      velocityX: { type: "number" },
      velocityZ: { type: "number" },
      grounded: { type: "bool", default: true },
    },
    states: [{ id: "locomotion", clipId: "idle", loop: true }],
    transitions: [],
  });

  assert.deepEqual(evaluateBlendSpace(locomotion1D, machine.getParameters()), [{ clipId: "idle", weight: 1 }]);
  machine.set("speed", 4);
  assert.deepEqual(evaluateBlendSpace(locomotion1D, machine.getParameters()), [{ clipId: "run", weight: 1 }]);

  machine.set("velocityX", 1);
  assert.deepEqual(evaluateBlendSpace(strafe2D, machine.getParameters()), [{ clipId: "right", weight: 1 }]);

  assert.throws(
    () => evaluateBlendSpace({ ...locomotion1D, parameter: "grounded" }, machine.getParameters()),
    /parameter "grounded" must be a number, got boolean/,
  );
  assert.throws(
    () => evaluateBlendSpace({ ...locomotion1D, parameter: "missing" }, machine.getParameters()),
    /parameter "missing" must be a number, got undefined/,
  );
});

test("validation rejects untyped JSON shapes with diagnostics instead of throwing", () => {
  assert.deepEqual(codes(null as unknown as BlendSpaceDefinition), ["anim.blendSpace.invalid"]);
  assert.deepEqual(
    codes({ ...locomotion1D, samples: undefined } as unknown as BlendSpaceDefinition),
    ["anim.blendSpace.samples.invalid"],
  );
  assert.deepEqual(
    codes({ ...locomotion1D, samples: [null, { clipId: "walk", position: 1 }] } as unknown as BlendSpaceDefinition),
    ["anim.blendSpace.sample.invalid"],
  );
  assert.deepEqual(
    codes({ ...strafe2D, parameters: undefined } as unknown as BlendSpaceDefinition),
    ["anim.blendSpace.parameter.empty"],
  );
  assert.deepEqual(
    codes({ ...strafe2D, parameters: ["a", "b", "c"] } as unknown as BlendSpaceDefinition),
    ["anim.blendSpace.parameter.empty"],
  );
  assert.deepEqual(
    codes({ ...locomotion1D, samples: [{ clipId: 7, position: 0 }] } as unknown as BlendSpaceDefinition),
    ["anim.blendSpace.sample.clip.empty"],
  );
  assert.deepEqual(codes({ ...locomotion1D, id: "" }), ["anim.blendSpace.id.empty"]);
});

test("2D weights stay non-empty and normalized far outside the sample hull", () => {
  const probes: Array<[number, number]> = [
    [100, 37],
    [-1000, -1000],
    [1e6, 0],
    [0, -1e6],
    [-3, 2],
  ];
  for (const [x, y] of probes) {
    const weights = evaluateBlendSpace2D(strafe2D, x, y);
    assert.ok(weights.length > 0, `non-empty at ${x},${y}`);
    assert.ok(Math.abs(sum(weights) - 1) < 1e-9, `sum at ${x},${y}`);
    assert.equal(weightOf(weights, "idle"), 0, `centre sample does not leak in at ${x},${y}`);
  }
});

test("equal weights are ordered by clip id independent of locale", () => {
  const space: BlendSpace1DDefinition = {
    schemaVersion: 1,
    kind: "1d",
    id: "tie",
    parameter: "speed",
    samples: [
      { clipId: "b", position: 1 },
      { clipId: "B", position: 0 },
    ],
  };
  const weights = evaluateBlendSpace1D(space, 0.5);
  assert.deepEqual(weights.map((w) => w.clipId), ["B", "b"], "code-point order puts uppercase first");
});

test("2D blend works with an irregular, non-symmetric sample layout", () => {
  const irregular: BlendSpace2DDefinition = {
    schemaVersion: 1,
    kind: "2d",
    id: "irregular",
    parameters: ["x", "y"],
    samples: [
      { clipId: "a", position: [0, 0] },
      { clipId: "b", position: [3, 0.5] },
      { clipId: "c", position: [-1, 2] },
    ],
  };
  for (let ix = -10; ix <= 10; ix++) {
    for (let iy = -10; iy <= 10; iy++) {
      const weights = evaluateBlendSpace2D(irregular, ix * 0.4, iy * 0.4);
      assert.ok(weights.length > 0);
      assert.ok(Math.abs(sum(weights) - 1) < 1e-9);
    }
  }
  assert.deepEqual(evaluateBlendSpace2D(irregular, 3, 0.5), [{ clipId: "b", weight: 1 }]);
});
