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

## Implemented semantics (`@kinetra/command-bus`)

- A rejected command or transaction never mutates the project and never bumps the revision. Rejections are `CommandError`s with a `code` and a `remediation`, except whole-document schema failures, which surface as `ProjectValidationError` with structured `issues`.
- `entity.reparent` rejects a parent that is the entity itself or one of its descendants with `PARENT_CYCLE`.
- Undo is last-in, first-out. Only the most recent un-undone execution can be undone; an older token returns `UNDO_CONFLICT` instead of silently discarding newer changes. Undoing a change is itself a new revision. Dry runs and failed transactions produce no undo token.
- `component.patch` rejects the reserved component names `__proto__`, `constructor` and `prototype`.
- `queryEntities` floors fractional `offset`/`limit`, treats non-finite values as the defaults (offset 0, limit 100) and clamps `limit` to 1..500.
- These rules are pinned by `packages/command-bus/test/regressions.test.ts` and the seeded model-based suite `packages/command-bus/test/property.test.ts`.

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

Avoid a single universal \`execute_json\` as the primary public MCP API. Semantic tools provide better schemas, smaller contexts and safer permissions.

## Query efficiency

Default queries return IDs/names/component summaries. Large scenes, logs and asset databases must support field selection, filters, pagination and revision diffs.
