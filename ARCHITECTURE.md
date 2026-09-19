# Architecture

## Core separation

Kinetra deliberately separates three models.

### 1. Project model

Serializable authoring data:

- projects;
- scenes;
- entities/components;
- prefab definitions and overrides;
- assets and import recipes;
- animation graphs;
- input maps;
- build settings;
- acceptance manifests.

It is text-first, schema-versioned and Git-friendly.

### 2. Runtime model

Instantiated/transient state:

- Three.js objects/materials/textures;
- Rapier bodies/colliders;
- AnimationMixer/actions;
- audio nodes;
- navmesh/crowd handles;
- loaded resource handles;
- gameplay state and transient caches.

Runtime objects are never the authoritative editor/project format.

### 3. Command model

The only supported authoring mutation surface.

~~~text
Human editor ─┐
              ├─> Command / Query API -> Project model -> Runtime projection
AI / MCP ─────┘
~~~

Commands provide validation, transactions, project revisions, undo tokens, structured diffs, dry-run support and checkpoints.

## High-level system

~~~text
                    Autonomous supervisor
                  planning • critique • done
                            │
                 model/provider adapters
                            │
                            ▼
                     MCP / Agent API
                            │
                            ▼
                 Command + Query Bus
         transactions • revisions • validation
          diffs • checkpoints • undo • replay
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        Project Model                 Event Log
              │
              ▼
          Game Runtime
   ┌──────────┼───────────┬───────────┐
   ▼          ▼           ▼           ▼
Three.js    Rapier      Recast      Web Audio
   │
 Asset manager / animation / input / save / UI
   │
   ├───────────────> Verification controller
   │                  state • input • logs • image
   │
   └───────────────> Production build -> Game.exe
~~~

## Invariants

- An editor reload must be reconstructible from project data.
- A runtime restart must not require editor UI state.
- A scene/prefab diff must be meaningful in Git.
- A stale agent must not silently overwrite a newer project revision.
- Asset source paths are not runtime identity; asset IDs are.
- Imported artifacts are reproducible from source + importer recipe where possible.
- Build output contains no editor/agent tooling unless explicitly required.
- Release acceptance is tested against packaged output, not only dev mode.

## Package boundaries

See the root README for the intended monorepo map. Package public APIs should remain narrower than their internal implementation and should not leak renderer/platform details upward unless unavoidable.

## Renderer abstraction

Gameplay/project components should not depend on a concrete Three.js renderer.

Conceptually:

~~~ts
interface RenderBackend {
  initialize(canvas: HTMLCanvasElement): Promise<void>;
  render(scene: unknown, camera: unknown): void;
  resize(width: number, height: number, dpr: number): void;
  getStats(): RenderStats;
  dispose(): Promise<void>;
}
~~~

The initial backends are WebGL2 and WebGPU-capable Three.js implementations. WebGPU support must not force game semantics to depend on WebGPU-only features.

## Resource ownership

Assets are acquired through handles. Scripts should not independently own arbitrary raw textures/models. Scene/world unload must release renderer, audio, physics and navigation resources.

## Platform boundary

Game code uses narrow platform services:

~~~text
Platform
 ├─ filesystem/save paths
 ├─ window/fullscreen
 ├─ clipboard (editor only)
 └─ optional Steam bridge
~~~

The renderer never receives broad Node privileges.

## Further docs

- \`docs/architecture/PROJECT_MODEL.md\`
- \`docs/architecture/COMMAND_API.md\`
- \`docs/architecture/ASSET_PIPELINE.md\`
- \`docs/architecture/BLENDER_BRIDGE.md\`
- \`docs/architecture/ANIMATION.md\`
- \`docs/architecture/VERIFICATION.md\`
- \`docs/architecture/DESKTOP_BUILD.md\`
- \`docs/architecture/AGENT_ORCHESTRATION.md\`
