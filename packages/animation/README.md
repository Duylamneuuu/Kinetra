# @kinetra/animation

AI-readable animation semantics layered above Three.js runtime primitives.

Everything in this package is **pure data + deterministic functions**: no
Three.js scene objects are created or mutated here. The runtime adapters live in
`@kinetra/renderer-three` (`ThreeSceneRuntime`, `BlendSpacePlayback`,
`MorphTargetController`, `IkController`) and the player bridge exposes them as
`animation.*` commands. A future visual graph editor is just another frontend
over these structures.

## Entry points

| Import | What it holds | Proof level |
| --- | --- | --- |
| `@kinetra/animation` | everything below, re-exported | — |
| `@kinetra/animation/graph` | `AnimationGraphDefinition`, `validateAnimationGraph`, `AnimationGraphMachine` (typed `bool`/`number`/`trigger` parameters, priorities, wildcard `from: "*"`) | unit + real Electron (`real-animation-graph`) |
| `@kinetra/animation/blend-space` | 1D/2D locomotion blend spaces: `validateBlendSpace`, `evaluateBlendSpace1D/2D`, `evaluateBlendSpace` | unit + runtime + real Electron (`real-blend-space`) |
| `@kinetra/animation/morph-targets` | morph target (blend shape) catalog and all-or-nothing weight validation | unit + runtime + real Electron (`real-morph-targets`) |
| `@kinetra/animation/ik` | analytic two-bone IK with pole, FABRIK, `solveIkChain`, `computeBoneAimRotations` | unit + runtime adapter tests; Electron proof covers error paths only |
| `@kinetra/animation/root-motion` | root-motion extraction policies | unit + real Electron + Rapier |
| (root only) | semantic humanoid skeleton profiles, skeleton signatures, retarget pairing, baked retarget cache keys, clip metadata/events | unit + real Electron retarget slice |

See `docs/STATUS.md` for exactly what is and is not proven for each feature.

## Design rules

- Every validator returns **structured diagnostics** (`code`, `message`,
  `remediation`) instead of throwing, so an agent can repair its input.
  Evaluation functions throw only on programmer errors (invalid definition,
  non-finite input).
- Output ordering never depends on the host locale (code-point comparisons).
- Definitions are schema-versioned (`schemaVersion: 1`) text data that can be
  stored in the project model and diffed.

## Examples

The examples below are executed by `pnpm check:docs` (see
`scripts/check-doc-examples.mjs`), so they are guaranteed to typecheck and run
against the current code.

### Animation graph driving a 1D blend space

```ts doc-check
import assert from "node:assert/strict";
import { AnimationGraphMachine, type AnimationGraphDefinition } from "@kinetra/animation/graph";
import { evaluateBlendSpace, validateBlendSpace, type BlendSpace1DDefinition } from "@kinetra/animation/blend-space";

const graph: AnimationGraphDefinition = {
  schemaVersion: 1,
  entryState: "idle",
  parameters: { speed: { type: "number", default: 0 } },
  states: [
    { id: "idle", clipId: "Idle" },
    { id: "locomotion", clipId: "Walk" },
  ],
  transitions: [
    { id: "start", from: "idle", to: "locomotion", conditions: [{ parameter: "speed", op: ">", value: 0.1 }], blendSeconds: 0.2 },
  ],
};

const locomotion: BlendSpace1DDefinition = {
  schemaVersion: 1,
  kind: "1d",
  id: "locomotion",
  parameter: "speed",
  samples: [
    { clipId: "Idle", position: 0 },
    { clipId: "Walk", position: 1.5 },
    { clipId: "Run", position: 4 },
  ],
};
assert.deepEqual(validateBlendSpace(locomotion), []);

const machine = new AnimationGraphMachine(graph);
machine.set("speed", 2.75);
const transition = machine.evaluate();
assert.equal(transition?.to, "locomotion");
assert.equal(transition?.blendSeconds, 0.2);

// Halfway between Walk (1.5) and Run (4): equal weights, sorted by weight then clip id.
const weights = evaluateBlendSpace(locomotion, machine.getParameters());
assert.deepEqual(weights, [
  { clipId: "Run", weight: 0.5 },
  { clipId: "Walk", weight: 0.5 },
]);
```

At runtime the same definition is played with
`ThreeSceneRuntime.playBlendSpace(entityId, definition, { input })` and steered
with `setBlendSpaceInput(entityId, input)`; clips of different lengths are phase-synced. Graph states
that *reference* a blend space are not implemented yet.

### Validation diagnostics are repairable

```ts doc-check
import assert from "node:assert/strict";
import { validateBlendSpace, type BlendSpace2DDefinition } from "@kinetra/animation/blend-space";

const strafe: BlendSpace2DDefinition = {
  schemaVersion: 1,
  kind: "2d",
  id: "strafe",
  parameters: ["velocityX", "velocityZ"],
  samples: [
    { clipId: "Idle", position: [0, 0] },
    { clipId: "Idle", position: [0, 0] },
  ],
};

const diagnostics = validateBlendSpace(strafe);
assert.ok(diagnostics.length > 0);
for (const diagnostic of diagnostics) {
  assert.match(diagnostic.code, /^anim\.blendSpace\./);
  assert.ok(diagnostic.remediation.length > 0, "every diagnostic carries a remediation hint");
}
```

### Morph targets by semantic name

A target name shared by several meshes (a `blink` on face and brows) is one
value. Requests are all-or-nothing: one bad entry rejects the whole request.

```ts doc-check
import assert from "node:assert/strict";
import {
  buildMorphTargetCatalog,
  summarizeMorphTargets,
  validateMorphWeightRequest,
  type MorphTargetMeshDescriptor,
} from "@kinetra/animation/morph-targets";

const meshes: MorphTargetMeshDescriptor[] = [
  { meshName: "Face", targetNames: ["smile", "blink"], influences: [0, 0] },
  { meshName: "Brows", targetNames: ["blink"], influences: [0] },
];
const catalog = buildMorphTargetCatalog(meshes);
assert.deepEqual(catalog.names, ["blink", "smile"]);
assert.deepEqual(
  summarizeMorphTargets(catalog, meshes).find((t) => t.name === "blink")?.meshes,
  ["Face", "Brows"],
);

const ok = validateMorphWeightRequest({ smile: 0.5, blink: 1 }, catalog);
assert.ok(ok.ok);
assert.deepEqual(ok.value, [
  { name: "blink", weight: 1 },
  { name: "smile", weight: 0.5 },
]);

const bad = validateMorphWeightRequest({ Smile: 0.5, blink: 2 }, catalog);
assert.ok(!bad.ok);
assert.deepEqual(
  bad.diagnostics.map((d) => d.code),
  ["anim.morph.unknownTarget", "anim.morph.weightOutOfRange"],
);
assert.match(bad.diagnostics[0]!.remediation, /did you mean "smile"/);
```

In the player, the same contract backs `animation.setMorphWeights` /
`animation.clearMorphWeights`, observable as `model.morphTargets`.

### Inverse kinematics

```ts doc-check
import assert from "node:assert/strict";
import { solveIkChain, validateIkChainDefinition, type IkChainDefinition, type IkVec3 } from "@kinetra/animation/ik";

const leftArm: IkChainDefinition = {
  schemaVersion: 1,
  id: "left-arm",
  solver: "two-bone",
  joints: ["upperArm.L", "lowerArm.L", "hand.L"],
};
assert.deepEqual(validateIkChainDefinition(leftArm).filter((d) => d.severity === "error"), []);

// Straight arm along +X, 1 m per bone; reach for a point in front of the shoulder.
const pose: IkVec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
const result = solveIkChain(leftArm, pose, [1, 1, 0], { pole: [0, 0, -1] });

assert.ok(result.success);
assert.ok(result.reachable);
assert.ok(result.converged);
const [root, mid, end] = result.positions;
const distance = (a: IkVec3, b: IkVec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
assert.ok(Math.abs(distance(root!, mid!) - 1) < 1e-9, "bone lengths are preserved");
assert.ok(Math.abs(distance(mid!, end!) - 1) < 1e-9);
assert.ok(distance(end!, [1, 1, 0]) < 1e-6);
```

At runtime, `ThreeSceneRuntime.setIkChains` / `setIkTarget` / `clearIkTarget`
apply solved chains to named bones after `mixer.update()`; the player bridge
exposes them as `animation.ik.setChains` / `animation.ik.setTarget` /
`animation.ik.clearTarget`. IK on a real skinned model through the bridge is not
yet proven.
