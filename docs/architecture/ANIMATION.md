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

## Locomotion blend spaces

`@kinetra/animation` owns a pure, schema-versioned blend-space contract (`packages/animation/src/blend-space.ts`):

- `BlendSpace1DDefinition` — one number parameter (e.g. `speed`) and `{ clipId, position }` samples. Weights are linear between the two neighbouring samples and clamp to the outermost sample beyond the ends.
- `BlendSpace2DDefinition` — two number parameters (e.g. `velocityX`, `velocityZ`) and `{ clipId, position: [x, y] }` samples. Weights use cartesian gradient band interpolation (Johansen 2009), implemented from the published description.
- `validateBlendSpace` returns structured `anim.blendSpace.*` diagnostics with remediation hints (empty/duplicate parameters, empty/duplicate clips, overlapping or non-finite positions, unknown kind/schemaVersion).
- `evaluateBlendSpace(space, machine.getParameters())` returns `{ clipId, weight }[]`, weights normalized to 1, exact on samples, sorted heaviest first, deterministic and independent of sample order.

The module does not touch Three.js. Runtime playback (mapping weights onto `AnimationAction`s, phase sync between locomotion clips, graph states that reference a blend space) is a separate, not-yet-proven slice.
