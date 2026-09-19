# Asset pipeline

## Canonical policy

- Source/DCC formats: Blender and compatibility ingress such as FBX.
- Runtime interchange: **glTF/GLB**.
- Runtime identity: **asset ID**, not file path.
- Production processing: deterministic recipe + content hash.

## Pipeline

~~~text
source .blend
 ↓
Blender official glTF export
 ↓
staging .glb
 ↓
validation
 ├─ mesh/material presence
 ├─ textures
 ├─ skeleton/skin weights
 ├─ morph targets
 ├─ clip names
 ├─ scale/transforms
 ├─ bounds
 └─ extension support
 ↓
normalization
 ├─ units/scale
 ├─ forward/up convention
 ├─ skeleton signature
 ├─ clip naming
 └─ root-motion metadata
 ↓
glTF-Transform
 ├─ prune
 ├─ dedup
 ├─ animation resample
 ├─ Meshopt/Draco policy
 └─ KTX2/Basis texture policy
 ↓
hash/cache
 ↓
runtime asset
~~~

## Import recipes

A source change plus import-recipe change determines cache invalidation. Reimports should invalidate only dependents.

## Validation classes

Import should produce structured diagnostics, including:

- missing texture;
- unsupported/material downgrade;
- unexpected scale;
- unapplied transform;
- excessive texture dimensions;
- excessive polygon count relative to policy;
- malformed skin;
- missing expected humanoid bones;
- invalid/empty animation clip;
- unreasonable bounds;
- missing collision representation.

## Resource lifetime

Runtime scripts acquire asset handles rather than directly owning arbitrary Three.js resources. Scene unload and hot reload must have explicit disposal behavior.
