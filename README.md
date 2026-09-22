# Kinetra

**AI-native 3D game engine built on Three.js.**

Kinetra is not trying to become another Unity-style editor that humans must learn. Its primary user is an **AI coding/game-development agent**.

The core product thesis is simple:

> **MCP is the AI's editor. The visual editor is the human's window into the same command system. Automated playtesting is what turns generated code into a finished game.**

## Current development state

Kinetra is currently at a **pre-alpha architecture/handoff checkpoint**.

Several foundational and subsystem cores are merged. Runtime, physics, navigation, and the Kinetra Arena reference game have proof at the levels recorded in [docs/STATUS.md](./docs/STATUS.md). The observer editor and release/Steam work are not finished.

Before implementing anything, read:

- [docs/HANDOFF.md](./docs/HANDOFF.md)
- [docs/STATUS.md](./docs/STATUS.md)
- [AGENTS.md](./AGENTS.md)
- [ROADMAP.md](./ROADMAP.md)

Do **not** infer that a feature is finished because a package folder or open PR exists.

## Linux runtime check

On Linux:

```bash
pnpm --filter @kinetra/player smoke:linux
```

That command builds the real Electron player, launches it under xvfb when `DISPLAY` is unset, forces software rendering, and drives Kinetra Arena through the existing stdio runtime bridge. It is development/runtime proof on Linux. Windows packaging proof stays on `package:win` / `smoke:win` and `KinetraGame.exe`.

## What Kinetra is for

Kinetra is being built so an agent can take a bounded game specification and do the whole production loop without relying on manual editor operation:

```text
spec
 -> plan + acceptance criteria
 -> structured scene/entity/prefab/script authoring
 -> deterministic asset import
 -> gameplay/runtime work
 -> run the real game
 -> inject semantic input
 -> inspect state + logs + frames
 -> fix
 -> repeat until acceptance passes
 -> package Game.exe
 -> launch and test the packaged executable
```

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

```text
AI supervisor / coding agent
          |
          v
     MCP / Agent API
          |
          v
 Typed Command + Query Bus
          |
     +----+-----+
     |          |
     v          v
Text project   Human observer
model          editor
     |
     v
Runtime systems
Three.js + game subsystems
     |
     v
Verification
     |
     v
Windows packaged game
```

See [docs/architecture/SYSTEM_MAP.md](./docs/architecture/SYSTEM_MAP.md) for package boundaries.

## Technology direction

| Layer | Direction |
|---|---|
| Rendering | Three.js behind a renderer adapter |
| Language | TypeScript wherever practical |
| Project data | Versioned text/JSON-like data with stable IDs |
| Engine model | Entity/component authoring model separate from raw Three.js scene graph |
| Physics | Rapier adapter |
| Navigation | Recast/Detour adapter, offline-baked by default |
| 3D interchange | glTF/GLB |
| DCC | Blender + official glTF export |
| Desktop | Electron first |
| AI control | Typed semantic command/query/runtime tools |
| Verification | Structured runtime probes + semantic player actions |
| Windows shipping | Packaged executable is a required test target |

## Repository map

```text
apps/
  editor/             human observer/debug surface
  player/             development and packaged player shell

packages/
  project-model/      versioned authoring data
  command-bus/        supported authoring mutation path
  renderer-three/     Three.js projection/backend
  mcp-server/         agent-facing tools/service
  asset-pipeline/     asset identity/import/validation/cache
  blender-bridge/     headless Blender automation
  animation/          skeleton/retarget/root-motion/graph semantics
  core/               scripts/scenes/prefab lifecycle contracts
  input/              named actions/remapping
  audio/              mixer/bus semantics
  save-state/         save/settings migrations/storage contracts
  verification/       acceptance proof
  physics-rapier/     planned/WIP adapter boundary
  navigation-recast/  planned/WIP adapter boundary
  desktop-build/      planned/WIP release/platform boundary

agents/
  engine-guide/       compact machine guidance

docs/
  HANDOFF.md
  STATUS.md
  ENVIRONMENT_BOUNDARIES.md
  architecture/
  principles/
  research/

examples/
  reference-game/     future complete-game proof
```

## License

MIT. See [LICENSE](./LICENSE).

Third-party reuse is governed by [LICENSE-POLICY.md](./LICENSE-POLICY.md). GPL/AGPL projects may be studied as architectural references but must not be copied into Kinetra unless the licensing decision is made deliberately and documented.
