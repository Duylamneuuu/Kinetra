# @kinetra/mcp-server

The primary AI authoring gateway for Kinetra.

Kinetra treats MCP/typed commands as the AI's editor. This package adapts
semantic MCP tools onto the same project command bus used by every future human
UI. **Agent-facing usage guide:** [`docs/guides/AI_AGENT_MCP.md`](../../docs/guides/AI_AGENT_MCP.md)
(tool reference, recommended loop, error format, and an executed TypeScript
example).

## Tools on `main`

~~~text
project.inspect      project.diff        project.undo
scene.query          scene.create
entity.query         entity.create       entity.patch
entity.reparent      entity.delete
runtime.start        runtime.stop        runtime.query
runtime.injectInput  runtime.readLogs    runtime.captureFrame
test.runAcceptance
~~~

The source of truth is `createKinetraMcpServer` in `src/server.ts`.

The MCP layer does **not** mutate Three.js objects directly. Authoring tools
mutate the text project through `@kinetra/command-bus` (revision preconditions,
`dryRun`, undo tokens). `runtime.start` then instantiates a snapshot of the
current revision into the runtime host.

## Public API

| Export | Role |
| --- | --- |
| `createKinetraMcpServer(service)` | builds the `McpServer` with every tool above |
| `KinetraAgentService` | in-process service each tool wraps; `KinetraAgentService.fromFile(path)` persists committed mutations through `FileProjectStore` |
| `formatToolError(error)` | the structured `{ code, message, remediation, issues? }` body returned by failing tools |
| `LocalRuntimeHost` | default `RuntimeHost`: Three.js scene graph, no renderer; `captureFrame()` returns `available: false`; keeps at most `MAX_LOCAL_RUNTIME_LOG_ENTRIES` (5000) log entries |
| `ElectronRuntimeHost` | real Electron player (or packaged executable) host; used by `test.runAcceptance` |
| `FileProjectStore` | file-backed project persistence |

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

- The stdio CLI uses `LocalRuntimeHost` for the `runtime.*` tools. It never
  fakes a screenshot: `runtime.captureFrame` returns `available: false` with
  structured fallback state.
- `test.runAcceptance` launches a real `ElectronRuntimeHost` per run
  (`target: "runtime"` for the dev player, `target: "packaged"` for the packaged
  executable) and returns an `AcceptanceReport` with PNG/state/log evidence.
  Proof: `test/real-mcp-acceptance.test.ts` and the packaged smoke suites.
- An embedding host can pass `{ runtime: new ElectronRuntimeHost(...) }` to
  `KinetraAgentService` so `runtime.captureFrame` returns a real PNG; the CLI
  does not expose a flag for this yet.
