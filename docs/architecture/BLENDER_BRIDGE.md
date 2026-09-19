# Blender bridge

Blender is Kinetra's primary DCC, but AI should not depend on driving Blender's GUI.

## Direction

Build a thin, auditable automation bridge over Blender Python/headless execution.

Candidate semantic operations:

~~~text
blender.inspectScene
blender.importModel
blender.createMaterial
blender.modifyMesh
blender.createRig
blender.assignWeights
blender.createAnimation
blender.generateLOD
blender.generateCollider
blender.exportGLB
blender.renderPreview
~~~

These are not all Phase 0 requirements. The important early capability is deterministic inspect/export/re-export.

## Feedback loop

~~~text
AI task
 ↓
Blender bridge operation
 ↓
.blend/source update
 ↓
GLB export
 ↓
Kinetra import/validation
 ↓
runtime render/test
 ↓
state + metrics + screenshot
 ↓
AI critique
 ↓
Blender correction
 ↺
~~~

## Rules

- Store source .blend files under source assets when licensing allows.
- Runtime does not open .blend files.
- Export recipes are versioned.
- Blender version/export settings become part of provenance where reproducibility matters.
- GUI automation is fallback/debugging, not the canonical integration.
