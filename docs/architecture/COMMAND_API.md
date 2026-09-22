# Command and query API

The command/query layer is Kinetra's most important authoring contract.

## Goals

- same mutation path for editor and AI;
- validation before mutation;
- transactions;
- revision preconditions;
- dry runs;
- undo;
- structured diffs;
- replay/debuggability;
- narrow queries to control model context cost.

## Envelope shape

Illustrative contract:

~~~ts
interface CommandEnvelope<T = unknown> {
  requestId: string;
  command: string;
  payload: T;
  expectedProjectRevision?: number;
  transactionId?: string;
  dryRun?: boolean;
}

interface CommandResult {
  ok: boolean;
  revision: number;
  changes: Array<{
    kind: "created" | "updated" | "deleted";
    id: string;
  }>;
  warnings: string[];
  undoToken?: string;
}
~~~

## Initial semantic tool taxonomy

~~~text
project.inspect
project.diff

scene.query
scene.create
scene.delete

entity.create
entity.patch
entity.reparent
entity.delete

prefab.create
prefab.instantiate
prefab.applyOverrides

asset.search
asset.import
asset.inspect
asset.optimize

animation.listClips
animation.retarget
animation.graph.patch

runtime.start
runtime.stop
runtime.query
runtime.injectInput
runtime.captureFrame
runtime.readLogs

test.runAcceptance

build.windows
~~~

Avoid a single universal `execute_json` as the primary public MCP API. Semantic tools provide better schemas, smaller contexts and safer permissions.

The implemented MCP tools are the list in `packages/mcp-server/README.md`, including `input.query` and `test.runAcceptance`. Prefab, asset, animation, and `build.windows` names in the taxonomy above are not MCP tools yet.

## Query efficiency

Default queries return IDs/names/component summaries. Large scenes, logs and asset databases must support field selection, filters, pagination and revision diffs.
