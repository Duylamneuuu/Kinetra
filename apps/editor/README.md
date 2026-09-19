# @kinetra/editor

Kinetra's **human observer/debug shell**.

Humans do not need to learn Kinetra to make AI agents productive. This editor exists to watch, inspect, debug and occasionally override the same structured authoring state that agents manipulate through MCP.

## P3 surface

- Electron + React shell
- Three.js observer viewport
- hierarchy + selection
- TransformControls translate/rotate/scale
- schema-driven inspector for known components
- generic Monaco JSON component editor
- lightweight asset-ID browser
- render stats
- Play/Stop authoring lock
- command history/console
- project file load/save bridge

Every mutation — gizmo, inspector, Monaco, add box, delete — becomes a semantic `CommandBus` operation. There is no editor-only authoring path.

Run against a project with:

~~~bash
KINETRA_PROJECT=/absolute/path/game.kinetra.json electron apps/editor/dist/package
~~~

Without a project path the editor opens a non-persistent demo scene.
