# @kinetra/editor

Human observer/debug application.

The editor is deliberately secondary to the command/MCP surface. It will provide a viewport, hierarchy, schema-driven inspector, asset browser, Monaco, console/profiler and Play/Stop while issuing the same commands as agents.

## Status

Only the UI-independent core exists so far (no window, viewport or Electron shell yet):

- `buildHierarchy(scene)` flattens a scene into depth-first rows (`entityId`, `depth`, `parentId`, `childCount`, `components`, `detached`). It is pure and total: every entity appears exactly once, even if a hand-edited document has a dangling parent or a parent cycle (those rows are flagged `detached`).
- `EditorSession` wraps a `CommandBus`. Reads (`scenes`, `hierarchy`, `inspect`) come from bus snapshots, so the editor never owns a second copy of the project. Writes (`createScene`, `createEntity`, `patchComponent`, `reparent`, `deleteEntity`) are typed commands sent to the same bus an MCP client uses; there is no privileged path.
- `undo()`/`redo()` cover the editor's own edits. Because the bus undoes last-in-first-out, an undo after an agent committed on top fails with `UNDO_CONFLICT` instead of rewinding the agent's work, and a stale redo is dropped.
- `selection` holds entity ids and silently drops ones that were deleted or undone.

`test/mcp-parity.test.ts` proves the editor and `KinetraAgentService` (the MCP service) produce identical change records, project snapshots and event logs for the same edits, and fail with the same error codes on invalid ones.
