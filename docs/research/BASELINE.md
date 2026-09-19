# Research baseline — 2026-09-19

This document records the architectural conclusions that informed Kinetra's foundation. It is a snapshot, not permanent truth.

## Conclusion

Build a clean Three.js runtime kernel with a typed command/query plane. Use a Godogen-style supervisor above it, PlayCanvas Editor MCP as a mature tool-taxonomy reference, Blender→GLB as the content route, and executable-level verification as a first-class feature.

## Important ecosystem references

- Three.js: https://github.com/mrdoob/three.js
- Godogen: https://github.com/htdt/godogen
- PlayCanvas Editor MCP Server: https://github.com/playcanvas/editor-mcp-server
- PlayCanvas engine: https://github.com/playcanvas/engine
- Triangle: https://github.com/pkyanam/Triangle
- StemStudio: https://github.com/Stem-Studio/Engine
- three-game-engine: https://github.com/WesUnwin/three-game-engine
- MavonEngine/Core: https://github.com/MavonEngine/Core
- glTF-Transform: https://github.com/donmccurdy/glTF-Transform
- Khronos glTF-Blender-IO: https://github.com/KhronosGroup/glTF-Blender-IO
- Rapier: https://github.com/dimforge/rapier
- recast-navigation-js: https://github.com/isaac-mason/recast-navigation-js
- 3JSE (reference-only by default): https://github.com/xirtus/3JSE
- Limina (reference-only by default): https://github.com/syndicalt/limina

## What to reuse vs own

**Own:** project model, command/query contracts, runtime lifecycle, asset identity/lifetime, verification semantics, agent completion protocol.

**Adopt directly where suitable:** Three.js, Rapier, Recast JS, official Blender glTF tooling, glTF-Transform.

**Study/selectively reuse permissive pieces:** Triangle/editor-agent shell ideas, Three.js editor patterns, PlayCanvas MCP taxonomy, small Three engine patterns.

**Reference architecture only by default:** GPL/AGPL implementations.

## Priority insight

The differentiator is not rendering. It is the loop:

> author → run → observe → test → fix → package → test packaged result.

If that loop is reliable, a relatively small human editor is enough.
