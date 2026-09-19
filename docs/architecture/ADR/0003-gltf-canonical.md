# ADR 0003 — glTF/GLB is canonical 3D interchange

**Status:** Accepted

## Decision

Blender and other DCC/source formats are authoring inputs. Kinetra's canonical runtime interchange is glTF/GLB.

## Consequences

- official Blender glTF export is the preferred Blender path;
- FBX is compatibility ingress, not canonical runtime data;
- validation/normalization/optimization happen after staging export;
- runtime references asset IDs for imported artifacts.
