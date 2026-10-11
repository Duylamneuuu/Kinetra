# @kinetra/editor

Human observer/debug application.

The editor is deliberately secondary to the command/MCP surface. It will provide a viewport, hierarchy, schema-driven inspector, asset browser, Monaco, console/profiler and Play/Stop while issuing the same commands as agents.

## Status

Only the UI-independent core exists so far (no window, viewport or Electron shell yet):

- `buildHierarchy(scene)` flattens a scene into depth-first rows (`entityId`, `depth`, `parentId`, `childCount`, `components`, `detached`). It is pure and total: every entity appears exactly once, even if a hand-edited document has a dangling parent or a parent cycle (those rows are flagged `detached`).
- `EditorSession` wraps a `CommandBus`. Reads (`scenes`, `hierarchy`, `inspect`) come from bus snapshots, so the editor never owns a second copy of the project. Writes (`createScene`, `createEntity`, `patchComponent`, `reparent`, `deleteEntity`) are typed commands sent to the same bus an MCP client uses; there is no privileged path.
- `undo()`/`redo()` cover the editor's own edits. Because the bus undoes last-in-first-out, an undo after an agent committed on top fails with `UNDO_CONFLICT` instead of rewinding the agent's work, and a stale redo is dropped.
- `selection` holds entity ids and silently drops ones that were deleted or undone.

- `buildInspector(entity, schemas?)` (`src/inspector.ts`) turns one entity into inspector sections and rows: per field the `kind` (`number`, `string`, `boolean`, `enum`, `vector3`, `color`, `json`), bounds (`min`/`max`/`exclusiveMin`/`exclusiveMax`), enum `options`, the known `default`, the current `value` (a copy) and whether it is `present`. Built-in components (`Transform`, `Primitive`, `Camera`, `Light`, `Model`, `Script`) are described by `BUILT_IN_INSPECTOR_SCHEMAS`; a test pins those descriptors to `validateBuiltInComponent` so they cannot drift, and rows whose value the project-model schema rejects carry its structured issue. Components with no descriptor, and fields a descriptor does not list, are shown raw and flagged `unknown`. It is pure and total: NaN, `null`, deeply nested arrays or non-object components never throw. `EditorSession.inspector(entityId)` builds it from a fresh bus snapshot.
- `EditorSession.setProperty(entityId, component, path, value)` edits one property (`"fov"`, `"position.1"` or `["position", 1]`) by sending a single `component.patch` through the bus, so validation, change records, undo and error codes are the bus's own. An unusable path (empty, `__proto__`, through a scalar, past the end of an array) fails with `INVALID_COMMAND` before anything is sent.

Not covered: the inspector has no UI, and there is no prefab model in `project-model` yet, so there is no `overridden` flag on rows. `default` is only filled where the runtime default is certain (Transform, Camera near/far).

`test/inspector.test.ts` and `test/set-property.test.ts` cover the inspector rows (including a generated-payload no-throw property test) and prove that the same `setProperty` sequence through the editor and the equivalent `patchComponent` calls through `KinetraAgentService` give identical change records, snapshot and event log, with identical error codes and messages for bad values.

- `buildAssetBrowser(records, { currentSourceHashes? })` (`src/assets.ts`) is the read-only asset panel model. It takes asset-database records (declared structurally, so the editor does not depend on `@kinetra/asset-pipeline`; `AssetDatabase.list()` output fits) and returns entries sorted by id (UTF-16 order) with `kind`, source `folder`/`name`, an import `status`, `issues`, direct `dependencies`/`dependents`, `missingDependencies`, `inCycle` and diagnostic counts, plus `byKind` / `byFolder` groups and a summary. `failed` means an error diagnostic, a dependency id that is not in the database, or membership of a dependency cycle (iterative Tarjan, so a 20k-long chain cannot overflow the stack); `stale` means the source hash on disk (supplied by the host per `source.path`) differs from the imported hash, or any transitive dependency is failed or stale. Malformed or duplicate records are skipped and listed in `invalid`; nothing throws. `filterAssetBrowser(model, { kinds, statuses, folder, search })` narrows the entries.
- `EditorConsole` (`src/console.ts`) is a bounded (`maxEntries`, default 1000), filterable (`minLevel`, `levels`, `sources`, `sinceSeq`, `limit`) log. `attachBus(bus)` + `sync()` mirror the command bus event log one entry per `CommandEvent` (the bus has no subscription API, so the host calls `sync()` after edits or on a timer); a console that falls behind the bus's bounded log records one warning saying how many events it missed. `log(level, source, message, data)` appends runtime or editor output; `data` is reduced to plain JSON (cycles, bigint, functions, throwing getters and oversized values become markers) so a bad argument cannot crash it. `subscribe()` returns an idempotent unsubscribe; a throwing listener is counted (`listenerErrorCount`) and never stops the others. Everything it returns is a deep copy.

Not covered: no UI for either panel, the console is not yet wired to a runtime host's own log (feed it with `log()`), the asset browser does not read the file system itself (the caller supplies current source hashes), and it does not check that an `importedPath` file exists.

`test/asset-browser.test.ts` and `test/console.test.ts` cover the above, including the cases named in #274: fresh/stale/failed, dependency cycles, unknown ids, truncation at the limit, level filtering, unsubscribe, unserialisable values, and parity with `KinetraAgentService.diffSince` for the same command sequence.

`test/mcp-parity.test.ts` proves the editor and `KinetraAgentService` (the MCP service) produce identical change records, project snapshots and event logs for the same edits, and fail with the same error codes on invalid ones.
