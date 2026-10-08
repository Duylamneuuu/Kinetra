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

## Compression policy

`@kinetra/asset-pipeline` inspects compression without decoding anything (`inspectGlbCompression` reads the GLB JSON chunk; `evaluateCompressionPolicy` judges it against a `CompressionPolicy`).

| Codec | Runtime decodes it today | Why |
| --- | --- | --- |
| Meshopt (`EXT_meshopt_compression`) | yes | self-contained WASM shipped in three.js; wired by `createRuntimeGltfLoader` |
| Draco (`KHR_draco_mesh_compression`) | no | needs external decoder files the player does not carry |
| KTX2/Basis (`KHR_texture_basisu`) | no | needs external transcoder files the player does not carry |

A required codec the runtime cannot decode is an `error` (loading would fail); an optional one is a `warning`. `RUNTIME_DECODER_CAPABILITIES` is the single table; flip an entry only after the loader and the packaged player can really decode that codec, and a test in `@kinetra/renderer-three` fails if the two tables disagree. The pipeline does not yet run an encoder: applying Meshopt is still an offline step.

## Resource lifetime

Runtime scripts acquire asset handles rather than directly owning arbitrary Three.js resources. Scene unload and hot reload must have explicit disposal behavior.
