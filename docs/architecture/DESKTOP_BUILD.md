# Desktop and Windows build

## v1 choice: Electron

Electron is the initial editor shell and Windows game packaging route because the bundled Chromium version gives a reproducible browser/runtime target while the engine is young.

This is not a claim that Electron is intrinsically faster or forever optimal.

## Artifacts

~~~text
Kinetra Editor
  development tool

GameName.exe
  shipped game

GameName-Setup.exe
  optional installer
~~~

Editor/MCP/agent dependencies must not leak into the shipped game unless explicitly required.

## Security boundary

Use main/preload/renderer separation, context isolation and narrow IPC. Game renderer code does not get unrestricted Node/process/filesystem access.

## Future alternatives

Tauri/WebView2 can be reevaluated after runtime contracts and compatibility tests stabilize. A custom native Three-compatible runtime is R&D only until the complete-game pipeline is proven.

## Steam

Keep Steam behind an optional platform bridge. The game runtime should work without Steam; a Steam adapter adds achievements/stats/overlay integration. Release files can later feed SteamPipe.
