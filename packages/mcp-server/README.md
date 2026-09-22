# @kinetra/mcp-server

The primary AI authoring gateway for Kinetra.

Kinetra treats MCP/typed commands as the AI's editor. This package adapts semantic MCP tools onto the same project command bus used by every future human UI.

## Current tool surface

~~~text
project.inspect
project.diff
project.undo

scene.query
scene.create

entity.query
entity.create
entity.patch
entity.reparent
entity.delete

input.query

runtime.start
runtime.stop
runtime.query
runtime.injectInput
runtime.readLogs
runtime.captureFrame

test.runAcceptance
~~~

The MCP layer does **not** mutate Three.js objects directly. Authoring tools mutate the text project through `@kinetra/command-bus`. `runtime.start` instantiates a snapshot into the connected runtime host.

`input.query` returns the engine-default semantic action ids (`player.moveForward`, `player.attack`, `game.pause`, and the rest of the player map) with their default bindings. Action ids stay stable when the player remaps keys.

`runtime.start`, `runtime.query`, and `runtime.injectInput` on the default CLI host use the local Three.js scene-graph. That host returns transforms and records semantic actions in logs. It does not run gameplay scripts. `test.runAcceptance` is the tool that drives the real Electron player, or the packaged Windows executable when `target` is `packaged`.

## Stdio

Build the workspace, then point an MCP client at:

~~~bash
node packages/mcp-server/dist/src/cli.js --project /absolute/path/game.kinetra.json
~~~

or set:

~~~text
KINETRA_PROJECT=/absolute/path/game.kinetra.json
~~~

The stdio process writes protocol traffic to stdout and errors only to stderr.

## Runtime capture status

The default CLI host is a local Three.js scene-graph. `runtime.captureFrame` on that host reports that raster capture is unavailable and returns structured fallback state.

`test.runAcceptance` runs the same observation contract against the Electron player. There, frame capture is a real PNG. Packaged Windows proof uses `target: "packaged"` and `KinetraGame.exe`.
