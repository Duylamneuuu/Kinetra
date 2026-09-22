# Starter project

`game.kinetra.json` is a minimal Kinetra project: one scene, a box, a camera, and a directional light. It has no gameplay script.

After a workspace build, an MCP client can open it with:

```bash
node packages/mcp-server/dist/src/cli.js --project examples/starter/game.kinetra.json
```

Start with `project.inspect`, `entity.query`, and `input.query`. Authoring changes go through the command tools (`entity.create`, `entity.patch`, `project.undo`) and must send `expectedProjectRevision` from `project.inspect`.

`runtime.start` on this CLI host projects the scene graph. It does not run Kinetra Arena. The playable reference game is `@kinetra/reference-game`, driven with `test.runAcceptance`.
