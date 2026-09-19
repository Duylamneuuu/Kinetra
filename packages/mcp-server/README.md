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

The MCP layer does **not** mutate Three.js objects directly. Authoring tools mutate the text project through `@kinetra/command-bus`. `runtime.start` then instantiates a project snapshot into the selected runtime host.

## Stdio

Build the workspace, then point an MCP client at:

~~~bash
node packages/mcp-server/dist/src/cli.js --project /absolute/path/game.kinetra.json
~~~

For real Electron rendering and PNG capture:

~~~bash
node packages/mcp-server/dist/src/cli.js \
  --project /absolute/path/game.kinetra.json \
  --runtime electron
~~~

Environment equivalents:

~~~text
KINETRA_PROJECT=/absolute/path/game.kinetra.json
KINETRA_RUNTIME=electron
~~~

The MCP stdio process writes protocol traffic to stdout and errors only to stderr.

## Runtime hosts

**local** is the portable default. It instantiates the Three.js scene graph in-process and supports structured state/log/input verification without a raster surface.

**electron** spawns the Kinetra player over a private JSONL stdio bridge. Project snapshots are rendered by the actual browser/Electron player; `runtime.captureFrame` uses Electron `webContents.capturePage()` and returns a real `image/png` MCP content item.

No local network port or WebSocket server is required for the bridge.
