# Animation architecture

Three.js provides the runtime primitives; Kinetra supplies game-engine semantics.

## Required layers

1. imported skeleton/skin;
2. semantic skeleton profile;
3. clip metadata;
4. optional retarget/bake;
5. root-motion extraction policy;
6. text animation graph;
7. runtime animator/state machine;
8. character motor integration.

## Skeleton profiles

Agents reason about semantic bones such as:

~~~text
root
hips
spine
chest
head
leftUpperArm
leftLowerArm
rightUpperArm
rightLowerArm
leftUpperLeg
rightUpperLeg
~~~

Imported skeletons retain artist names and provide a mapping to the semantic profile.

## Retargeting

Retarget general animations at import/first-use time where possible, then bake/cache the resulting target clip. Cache keys include source clip, target skeleton and retarget settings.

External sources such as Mixamo are ingress only, not engine dependencies.

## Root motion

Per-clip modes should support at least:

- none;
- extract-xz;
- extract-xyz;
- extract-xz-yaw.

Visual skeleton motion and physical character motion must not both apply the same displacement.

## Animation graph

The source of truth is text data. A future visual node editor is only another frontend.

Parameters, states, transitions, blend durations and events should be directly editable and queryable by agents.

`validateAnimationGraph` rejects, with structured `anim.*` diagnostics: unknown parameter types, defaults that do not match the parameter type (`anim.parameter.default.type`), non-finite state speeds and transition priorities, unknown condition operators, and condition values that cannot match their parameter (`anim.condition.value.type`: a non-finite number for a number parameter, a non-boolean or an ordering operator on a bool). Parameter names resolve as own properties only, so `toString`/`constructor` are never parameters. `AnimationGraphMachine.set` rejects non-finite numbers so NaN cannot reach comparisons or blend spaces. Equal-priority transitions are ordered by transition id in code-point order, independent of host locale.

## Locomotion blend spaces

`@kinetra/animation` owns a pure, schema-versioned blend-space contract (`packages/animation/src/blend-space.ts`):

- `BlendSpace1DDefinition` — one number parameter (e.g. `speed`) and `{ clipId, position }` samples. Weights are linear between the two neighbouring samples and clamp to the outermost sample beyond the ends.
- `BlendSpace2DDefinition` — two number parameters (e.g. `velocityX`, `velocityZ`) and `{ clipId, position: [x, y] }` samples. Weights use cartesian gradient band interpolation (Johansen 2009), implemented from the published description.
- `validateBlendSpace` returns structured `anim.blendSpace.*` diagnostics with remediation hints (empty/duplicate parameters, empty/duplicate clips, overlapping or non-finite positions, unknown kind/schemaVersion).
- `evaluateBlendSpace(space, machine.getParameters())` returns `{ clipId, weight }[]`, weights normalized to 1, exact on samples, sorted heaviest first, deterministic and independent of sample order.

The module does not touch Three.js.

### Runtime playback

`@kinetra/renderer-three` projects a blend space onto a `THREE.AnimationMixer` (`packages/renderer-three/src/blend-space-player.ts`, `ThreeSceneRuntime.playBlendSpace` / `setBlendSpaceInput` / `getBlendSpaceState`). The definition and axis input are the source of truth; action weights and time scales are recomputed from them.

- Every sample clip runs as a looping action; weights come from `evaluateBlendSpace`.
- Phase sync: all clips share one normalized phase. The cycle length is the weight-averaged clip duration, each action's time scale is `speed * clipDuration / cycle`, and action times are re-anchored to `phase * clipDuration` before every mixer update, so clips of different lengths keep their footfalls aligned without drift.
- Validation (definition, clip resolution incl. `_retargeted` variants, zero-length clips, speed, input axes) happens before anything playing is stopped; failures return structured `anim.blendSpace.*` codes. `setBlendSpaceInput` is atomic.
- Direct playback (`playAnimation`, `crossfadeAnimation`, a graph transition) or `stopAnimation` stops the blend space. Live asset reload restores it with its input and speed.
- Observation: `model.animation.blendSpace = { id, kind, parameters, input, weights, phase, cycleDuration, speed, dominantClip }`, `actions[].role = "blend"`, `activeClip` = dominant clip.
- Bridge commands: `animation.blendSpace.play`, `animation.blendSpace.setInput` (logs `animation.blendSpace.played` / `playFailed` / `inputFailed`).

Not yet supported: root motion while a blend space plays (refused with `anim.blendSpace.rootMotionUnsupported`), graph states that reference a blend space, and smooth crossfades into/out of a blend space.

## Morph targets

Morph targets (glTF blend shapes / Blender shape keys) are addressed by their
semantic name, never by mesh or slot index. Names come from
`mesh.extras.targetNames`, which three.js turns into `morphTargetDictionary`.

- `@kinetra/animation/morph-targets` is the pure contract: it builds a
  catalog of unique names (sorted by code point), binds a name to every
  `(mesh, slot)` that carries it, and validates requests. A weight request is
  all-or-nothing: an unknown name (with a case-sensitivity hint), a
  non-finite weight, or a weight outside `[0, 1]` rejects the whole request
  with `anim.morph.*` diagnostics, so callers never see a half-applied
  expression.
- `MorphTargetController` in `@kinetra/renderer-three` is created per model
  instance at attach time. The engine owns the overrides; three.js influence
  arrays are only written, never read back as the source of truth.
  Overrides are re-applied after `AnimationMixer.update`, so a runtime
  override wins over a clip that animates the same target; clearing an
  override hands the target back to the clip or to the authored default.
- `reloadAsset` carries overrides onto the new instance. Targets the new asset
  no longer has are dropped and reported (`droppedMorphOverrides`, logged as
  `animation.morphOverridesDropped`) instead of failing the reload.
- Bridge commands: `animation.setMorphWeights { entityId, weights }` and
  `animation.clearMorphWeights { entityId, names? }`. Game scripts reach the
  same path through `animation.setMorphWeights` / `clearMorphWeights`.
  Observation: `model.morphTargets = { targets: [{ name, weight, meshes,
  overridden }], overrides }`.

Not covered yet: morph weights as animation-graph parameters, crossfading
between override values, and packaged-binary proof.

## Inverse kinematics

IK is a pure contract in `@kinetra/animation/ik` (no Three.js dependency):

- `IkChainDefinition` (schemaVersion 1): stable `id`, `solver` (`"two-bone"` for limbs, `"fabrik"` for longer chains), `joints` ordered root -> end effector, optional `tolerance`, `maxIterations` (1..1024) and `weight` (0..1).
- `validateIkChainDefinition` returns structured `ik.chain.*` diagnostics with remediation.
- `solveTwoBoneIk` is analytic (law of cosines) with an optional pole hint choosing the bend plane; `solveFabrikIk` is iterative FABRIK with a fixed root. Both preserve bone lengths exactly, never mutate input, are deterministic, and report `reachable`, `converged`, `iterations`, `error` and `ik.solve.*` diagnostics (out-of-reach, inside-min-reach, target-at-root, pole-degenerate, not-converged, non-finite, zero-length-bone) instead of throwing.
- `computeBoneAimRotations` converts solved positions into world-space shortest-arc rotations per bone for a runtime adapter.

IK produces a visual pose only. Physics and gameplay stay authoritative over entity transforms, exactly like root motion. The runtime adapter `IkController` (renderer-three) reads bone world positions after the mixer update and writes solved local rotations. It records the rotation it read and wrote per bone; a bone the mixer did not rewrite since the previous frame is put back to its input rotation before the next solve, so IK is idempotent on static or partially animated rigs and `clearIkTarget` returns the bones to the input pose. Chains are applied in chain-id order.
