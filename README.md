# Kinetra

**AI-native 3D game engine built on Three.js.**

Kinetra is not trying to become another Unity-style editor that humans must learn. Its primary user is an **AI coding/game-development agent**.

The core product thesis is simple:

> **MCP is the AI's editor. The visual editor is the human's window into the same command system. Automated playtesting is what turns generated code into a finished game.**

## What Kinetra is for

Kinetra is being built so an agent can take a bounded game specification and, without relying on manual editor操作, do the whole production loop:

~~~text
spec
 ↓
plan + acceptance criteria
 ↓
create scenes / entities / prefabs / scripts
 ↓
create or import Blender / GLB assets
 ↓
rig / animate / retarget
 ↓
build gameplay
 ↓
run the real game
 ↓
inject semantic input
 ↓
inspect runtime state + logs + screenshots
 ↓
fix
 ↓
repeat until acceptance passes
 ↓
package Game.exe
 ↓
launch and test the packaged executable
~~~

A successful Kinetra project is not "a nice Three.js demo". It is a game with a boot flow, menus, gameplay loop, win/lose states, audio, settings, save/load, input remapping/controller support, packaging, and executable-level verification.

## Non-goals

Kinetra is **not**:

- a Unity/Godot editor clone;
- a visual tool that requires human drag-and-drop skill;
- a prompt-to-screenshot toy;
- a custom renderer;
- a Blender replacement;
- tied to one model provider.

Human-facing UI exists for observation, debugging and exceptional override. If a feature is excellent for humans but difficult for agents, and a structured alternative can solve the same problem, the structured alternative wins.

## Architecture at a glance

~~~text
Godogen-style supervisor / Claude / Codex / other agents
                         │
                         ▼
                  MCP / Agent API
                         │
                         ▼
              Typed Command + Query Bus
       validation • transactions • revisions
          undo • diffs • checkpoints • replay
                         │
           ┌─────────────┴─────────────┐
           ▼                           ▼
   Text Project Model             Human Editor
 scenes • prefabs • data        viewport • debug
 scripts • anim graphs              observer
           │
           ▼
                  Kinetra Runtime
   Three.js • Rapier • Recast • Web Audio
 animation • input • UI • save/load • assets
           │
      ┌────┴───────────────┐
      ▼                    ▼
Verification          Production build
player bot            Vite + Electron
state asserts              │
screenshots                ▼
perf gates             Game.exe
~~~

## Technology direction

| Layer | Direction |
|---|---|
| Rendering | Three.js behind a WebGL2/WebGPU backend abstraction |
| Language | TypeScript wherever practical |
| Project data | Versioned JSON/JSONC + TypeScript, stable IDs |
| Engine model | Entity/component model separate from raw Three.js scene graph |
| Physics | Rapier |
| Navigation | recast-navigation-js, offline-baked by default for static worlds |
| 3D interchange | glTF/GLB |
| DCC | Blender + official Khronos glTF exporter |
| Asset processing | glTF-Transform + Meshopt/Draco + KTX2/Basis |
| Desktop editor | Electron + React + Monaco + Vite |
| AI control | Typed command/query API exposed through MCP |
| Autonomous layer | Godogen-style orchestration above the engine |
| Verification | Engine-native probes + semantic player bot + Playwright/screenshot tests |
| Windows shipping | Electron first; alternatives evaluated only after runtime contracts stabilize |

## Repository map

~~~text
apps/
  editor/             human observer/debug editor
  player/             development player shell

packages/
  core/               runtime contracts and lifecycle
  project-model/      versioned authoring data
  command-bus/        sole supported authoring mutation path
  renderer-three/     Three.js backend adapter
  physics-rapier/     physics and character motor
  navigation-recast/  navmesh bake/query/crowd integration
  animation/          skeletons, retargeting, root motion, anim graph
  asset-pipeline/     import/validate/optimize/cache
  blender-bridge/     headless Blender automation
  mcp-server/         agent-facing tools
  verification/       runtime probes, player bot, acceptance system
  desktop-build/      Windows packaging/platform bridges

agents/
  engine-guide/       compact machine-readable operating guidance

docs/
  architecture/       design contracts and ADRs
  principles/         product rules that should not drift
  research/           research baseline and donor/license policy

examples/
  reference-game/     eventually: the first complete shipping proof
~~~

## Current status

**Foundation / pre-alpha.** The first meaningful milestone is not a polished editor. It is:

> An agent creates and edits a bounded Three.js game through structured tools, imports a Blender asset, runs and verifies the game, then produces a Windows executable that passes an acceptance smoke suite.

See [ROADMAP.md](./ROADMAP.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and [AGENTS.md](./AGENTS.md).

## License

MIT. See [LICENSE](./LICENSE).

Third-party reuse is governed by [LICENSE-POLICY.md](./LICENSE-POLICY.md). GPL/AGPL projects may be studied as architectural references but must not be copied into Kinetra unless the licensing decision is made deliberately and documented.
