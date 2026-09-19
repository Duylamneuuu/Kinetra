# @kinetra/mcp-server

The primary AI authoring gateway for Kinetra.

Kinetra treats MCP/typed commands as the AI's editor. This package adapts semantic MCP tools onto the same project command bus used by every future human UI.

## Current P2 surface

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

runtime.start
runtime.stop
runtime.query
runtime.injectInput
runtime.readLogs
runtime.captureFrame
~~~

The MCP layer does **not** mutate Three.js objects directly. Authoring tools mutate the text project through `@kinetra/command-bus`. `runtime.start` then instantiates a snapshot into the runtime model.

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

P2 currently includes a local Three.js **scene-graph** runtime host that supports start/stop/state query/logs/semantic input. It intentionally does not fake a screenshot: `runtime.captureFrame` reports that raster capture is unavailable and returns structured fallback state.

A later P2 bridge connects the MCP service to the Electron/browser player so the same tool returns a real frame without changing the MCP contract.
