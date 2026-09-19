# Open-source reuse and license policy

Kinetra is MIT-licensed. AI-assisted development makes license boundaries especially important because an agent can accidentally copy an implementation from an incompatible donor.

## Default reuse policy

| License | Policy |
|---|---|
| MIT | Allowed with required notices preserved |
| BSD-2-Clause | Allowed with notices preserved |
| BSD-3-Clause | Allowed with notices preserved |
| Apache-2.0 | Allowed with NOTICE/patent obligations reviewed |
| GPL-2.0/3.0 | **Reference-only by default** |
| AGPL-3.0 | **Reference-only by default** |
| Unknown/custom | Block until reviewed |

This is an engineering policy, not legal advice.

## Reference-only means

Agents may:

- read public architecture/docs;
- learn concepts and API shapes;
- independently implement the idea against Kinetra's own contracts.

Agents must not:

- copy source files;
- paste substantial implementation;
- mechanically translate code;
- preserve unique implementation structure while merely renaming symbols.

## Known research donors

### Permissive candidates/reference

- Three.js — MIT
- Godogen — MIT
- PlayCanvas engine — MIT
- PlayCanvas Editor MCP Server — MIT
- Triangle — MIT
- StemStudio — MIT
- WesUnwin/three-game-engine — MIT
- MavonEngine/Core — MIT
- glTF-Transform — MIT
- recast-navigation-js — MIT
- Rapier — Apache-2.0
- Khronos glTF-Blender-IO — Apache-2.0

### Reference-only unless policy changes

- 3JSE — GPL-3.0
- Limina — AGPL-3.0/commercial licensing

## Agent instruction

If the fastest solution requires copying from a reference-only donor, stop and implement independently from the behavioral requirement or ask for a licensing decision. Do not silently import licensing obligations into Kinetra.
