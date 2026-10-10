# Driving Kinetra from an AI agent (MCP tools)

This guide is for an AI coding/authoring agent that talks to Kinetra through the
MCP server in `@kinetra/mcp-server`. It describes the tools that exist on
`main` today, the loop an agent should follow, and how errors are reported.
The tool list is taken from `packages/mcp-server/src/server.ts`; if the two ever
disagree, the source wins and this file is a bug.

## Mental model

```mermaid
flowchart TD
    Agent["AI agent"] -->|MCP stdio| Server["@kinetra/mcp-server<br/>createKinetraMcpServer"]
    Server --> Service["KinetraAgentService"]
    Service -->|typed commands + revision checks| Bus["@kinetra/command-bus<br/>CommandBus"]
    Bus --> Project[("Text project<br/>game.kinetra.json")]
    Service -->|runtime.* tools| Local["LocalRuntimeHost<br/>(Three.js scene graph, no raster)"]
    Service -->|test.runAcceptance| Electron["ElectronRuntimeHost<br/>(real player or packaged exe)"]
    Project -.snapshot at runtime.start.-> Local
    Electron --> Report["AcceptanceReport<br/>(state, logs, PNG evidence)"]
```

Rules that follow from this shape:

- **The text project is the source of truth.** Authoring tools mutate it only
  through the command bus; nothing touches Three.js objects directly.
- **The runtime is a projection.** `runtime.start` instantiates the *current*
  project revision. After an authoring change, stop and start the runtime again
  to see it.
- **Every committed mutation bumps the revision** and returns an `undoToken`.

## Starting the server

```bash
pnpm install && pnpm build
node packages/mcp-server/dist/src/cli.js --project /absolute/path/game.kinetra.json
# or: KINETRA_PROJECT=/absolute/path/game.kinetra.json node packages/mcp-server/dist/src/cli.js
```

Protocol traffic goes to stdout; errors go only to stderr. Committed mutations
are persisted to the project file.

## Tools

| Tool | Purpose | Key inputs |
| --- | --- | --- |
| `project.inspect` | revision, id, name, schema version, scenes with entity counts | — |
| `project.diff` | command events recorded after a revision (this server session only) | `sinceRevision` (default 0) |
| `project.undo` | consume an undo token from a committed mutation | `undoToken`, `expectedProjectRevision?` |
| `scene.query` | list scenes | `id?` |
| `scene.create` | create a scene | `name`, `id?`, `expectedProjectRevision?`, `dryRun?` |
| `entity.query` | query only what you need (paged) | `sceneId?`, `ids?` (≤500), `component?`, `nameContains?`, `selectComponents?`, `offset?`, `limit?` (1–500) |
| `entity.create` | create an entity with components | `sceneId`, `name`, `id?`, `parentId?`, `components?`, `expectedProjectRevision?`, `dryRun?` |
| `entity.patch` | merge fields into one component | `entityId`, `component`, `patch`, `expectedProjectRevision?`, `dryRun?` |
| `entity.reparent` | move an entity under another parent (or to the root) | `entityId`, `parentId?`, `expectedProjectRevision?`, `dryRun?` |
| `entity.delete` | delete an entity; hierarchies need `cascade: true` | `entityId`, `cascade?`, `expectedProjectRevision?`, `dryRun?` |
| `runtime.start` | instantiate the current revision of a scene into the local runtime | `sceneId` |
| `runtime.stop` | dispose the local runtime | — |
| `runtime.query` | live scene-graph state by stable entity id | `entityIds?` (≤500) |
| `runtime.injectInput` | inject a semantic action (`press`/`release`/`hold`) | `action`, `phase`, `value?`, `durationMs?` |
| `runtime.readLogs` | structured runtime logs after a cursor | `sinceSequence` (default 0) |
| `runtime.captureFrame` | frame capture; the local runtime returns `available: false` (it never fakes a screenshot) | — |
| `test.runAcceptance` | run an `AcceptanceManifest` against the real Electron runtime (`target: "runtime"`) or the packaged executable (`target: "packaged"`) | `manifest`, `target?`, `project?`, `assets?`, `timeoutMs?` (1 000–180 000) |

Notes on what is and is not wired today:

- The stdio CLI uses `LocalRuntimeHost` for the `runtime.*` tools: a Three.js
  scene graph without a renderer. Real pixels come from `test.runAcceptance`,
  which launches an `ElectronRuntimeHost` per run. `KinetraAgentService` can be
  constructed with `{ runtime: new ElectronRuntimeHost(...) }` by an embedding
  host, but the CLI does not expose a flag for it.
- Animation features (blend spaces, morph targets, IK) are reachable through the
  player runtime bridge (`animation.*` commands) and acceptance manifests, not
  as dedicated MCP tools yet.

## The recommended loop

1. `project.inspect` — learn the current `revision` and scene ids.
2. Query narrowly (`entity.query` with `selectComponents`/`limit`) instead of
   dumping scenes.
3. Mutate with `expectedProjectRevision` set to the revision you last saw. Use
   `dryRun: true` first when unsure; a dry run validates and reports changes
   without committing.
4. Keep the returned `undoToken` if you may need to roll back.
5. `runtime.stop` → `runtime.start` → `runtime.query` / `runtime.readLogs` to
   observe the change.
6. Prove completion with `test.runAcceptance` (state assertions, log
   absence, screenshots, metrics). Compilation or a plausible frame is not
   completion.

## Errors are structured

A failing tool returns `isError: true` and a JSON body:

```json
{
  "code": "STALE_REVISION",
  "message": "…",
  "remediation": "Call project.inspect, then retry this command with expectedProjectRevision set to the current revision."
}
```

Command-bus codes: `STALE_REVISION`, `SCENE_NOT_FOUND`, `SCENE_ALREADY_EXISTS`,
`ENTITY_NOT_FOUND`, `ENTITY_ALREADY_EXISTS`, `PARENT_NOT_FOUND`,
`PARENT_CYCLE`, `CHILDREN_EXIST`, `COMPONENT_NOT_OBJECT`, `INVALID_COMMAND`,
`UNDO_CONFLICT`, `UNDO_EXPIRED` (the undo token fell out of the bounded undo history,
`maxUndoDepth` default 100). Project validation
failures add an `issues` array of `{ path, code, message, remediation? }`.
Always follow the `remediation` text before retrying; never retry the same call
unchanged.

Built-in components are validated when you author them. `entity.create` and
`entity.patch` reject a bad payload for `Transform`, `Primitive`, `Camera`,
`Light`, `Model` or `Script` (for example a `Transform.position` that is not
three finite numbers, or `Primitive.kind: "cylinder"`) with `issues` such as
`component.Primitive.kind.invalid`, each with a `remediation`, and the revision
does not change. Unknown fields and other components (`Collider`, `RigidBody`,
custom ones) are free-form. The rules live in `validateBuiltInComponent` in
`@kinetra/project-model`.

## The same loop in TypeScript

Each MCP tool handler is a thin wrapper over a `KinetraAgentService` method, so
the loop can be exercised in-process. This example is executed by
`pnpm check:docs`.

```ts doc-check=mcp-server
import assert from "node:assert/strict";
import { stableId, type ProjectDocument } from "@kinetra/project-model";
import { KinetraAgentService, formatToolError } from "@kinetra/mcp-server";

const sceneId = stableId("scene", "guide-main");
const playerId = stableId("entity", "guide-player");
const project: ProjectDocument = {
  schemaVersion: 1,
  projectId: stableId("project", "guide"),
  name: "Guide",
  scenes: [{ id: sceneId, name: "Main", entities: [] }],
};

// In-memory service (no store): the CLI uses KinetraAgentService.fromFile(path).
const service = new KinetraAgentService(project);

// 1. inspect                                   -> project.inspect
assert.equal(service.inspectProject().revision, 0);

// 3. dry run, then commit with a revision guard -> entity.create
const transform = { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const preview = await service.createEntity({ sceneId, id: playerId, name: "Player", components: { Transform: transform }, expectedProjectRevision: 0, dryRun: true });
assert.equal(preview.revision, 0, "a dry run does not commit");
const created = await service.createEntity({ sceneId, id: playerId, name: "Player", components: { Transform: transform }, expectedProjectRevision: 0 });
assert.equal(created.revision, 1);
assert.ok(created.undoToken);

// A stale revision is rejected with a structured, repairable error.
await assert.rejects(
  service.patchComponent({ entityId: playerId, component: "Transform", patch: { position: [5, 0, 0] }, expectedProjectRevision: 0 }),
  (error: unknown) => {
    const body = JSON.parse(formatToolError(error)) as { code: string; remediation: string };
    assert.equal(body.code, "STALE_REVISION");
    assert.match(body.remediation, /project\.inspect/);
    return true;
  },
);

// 5. observe in the runtime projection         -> runtime.start / runtime.query
await service.startRuntime(sceneId);
const live = await service.queryRuntime({ entityIds: [playerId] });
assert.deepEqual(live.entities[0]?.position, [0, 1, 0]);
assert.equal((await service.captureRuntimeFrame()).available, false, "local runtime never fakes pixels");
await service.stopRuntime();

// 4. roll back                                 -> project.undo
const undone = await service.undo(created.undoToken!, 1);
assert.equal(undone.revision, 2);
assert.equal(service.queryScenes(sceneId)[0]?.entityCount, 0);

// A bad built-in component payload is rejected with field-level issues, and the revision stays put.
await assert.rejects(
  service.createEntity({ sceneId, name: "Cylinder", components: { Primitive: { kind: "cylinder" } }, expectedProjectRevision: 2 }),
  (error: unknown) => {
    const body = JSON.parse(formatToolError(error)) as {
      issues: Array<{ code: string; remediation?: string }>;
    };
    const issue = body.issues.find((entry) => entry.code === "component.Primitive.kind.invalid");
    assert.match(issue?.remediation ?? "", /box, sphere, plane/);
    return true;
  },
);
assert.equal(service.inspectProject().revision, 2);
```
