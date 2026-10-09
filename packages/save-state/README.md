# @kinetra/save-state

Versioned save envelopes with migrations, a small key-value storage abstraction, an atomic file-backed store for the desktop player, and the player settings document.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `SaveEnvelope<T>` | type | `{ schemaVersion, gameVersion, slotId, savedAt, data }`. |
| `SaveMigrator` | class | `new SaveMigrator(currentVersion)`, `register(fromVersion, fn)` (chainable), `migrate(envelope)`. Runs `fromVersion -> +1` steps in order on a clone of the data. |
| `createGameplaySaveMigrator()`, `CURRENT_SAVE_SCHEMA_VERSION` (`2`) | function, const | Engine migrator for `GameplaySaveData` (`{ sceneId, entities }`): v1 `entities[id].state` becomes v2 `gameplay`. |
| `KeyValueStorage` | interface | `get` / `set` / `delete` over strings, all async. |
| `MemoryStorage` | class | In-memory implementation for tests and headless runs. |
| `IpcKeyValueStorage`, `PlatformStorageBridge` | class, interface | Adapts the player's `storageGet/Set/Delete` IPC bridge to `KeyValueStorage`. |
| `JsonDocumentStore<T>` | class | `load` / `save` / `remove` JSON documents under `<prefix>:<key>`. |
| `SettingsStore`, `DEFAULT_PLAYER_SETTINGS`, `PlayerSettingsData` | class, const, type | Audio gains (0..1), fullscreen flag and optional custom input bindings. |
| `FileKeyValueStorage` (from `@kinetra/save-state/file`) | class | Node-only storage that writes one `<key>.json` per key under a root directory. |

## Behaviour worth knowing

- `migrate` throws for a non-object envelope, a `schemaVersion` that is not an integer `>= 1`, a save newer than the current build (`Save is newer than this game build`), or a missing step (`Missing save migration from schema N`). The input envelope is never mutated.
- `register` rejects a source version `>= currentVersion` and duplicate registrations.
- `SettingsStore.load` never fails on bad content: corrupt JSON, a non-object document or out-of-range gains fall back to defaults or clamp to `[0, 1]`, and malformed `customBindings` entries are dropped. Storage I/O errors still propagate.
- `FileKeyValueStorage` maps `saves:<slot>` to `<slot>.json` and `settings:<name>` to `settings_<name>.json`. Keys must match `[A-Za-z0-9_-]` segments joined by dots, so path traversal and Windows reserved device names (`nul`, `con`, ...) are rejected. `set` writes a temp file, fsyncs, then renames over the target with bounded retries; a failed write or rename removes the temp file and leaves the old document untouched.

## Example

```ts doc-check
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonDocumentStore,
  MemoryStorage,
  SettingsStore,
  createGameplaySaveMigrator,
  type GameplaySaveData,
  type SaveEnvelope,
} from "@kinetra/save-state";
import { FileKeyValueStorage } from "@kinetra/save-state/file";

// A schema v1 save is migrated forward on load.
const migrator = createGameplaySaveMigrator();
const v1: SaveEnvelope = {
  schemaVersion: 1,
  gameVersion: "0.1.0",
  slotId: "slot-a",
  savedAt: "2026-01-01T00:00:00.000Z",
  data: { sceneId: "arena", entities: { hero: { position: [0, 1, 0], state: { hp: 7 } } } },
};
const migrated = migrator.migrate<GameplaySaveData>(v1);
assert.equal(migrated.schemaVersion, 2);
assert.deepEqual(migrated.data.entities.hero, { position: [0, 1, 0], gameplay: { hp: 7 } });
assert.throws(() => migrator.migrate({ ...v1, schemaVersion: 99 }), /newer than this game build/);

// Settings tolerate junk and clamp values.
const memory = new MemoryStorage();
await memory.set("settings:user-settings", "{not json");
const settings = new SettingsStore(memory);
assert.equal((await settings.load()).audio.masterGain, 1);
await settings.save({ schemaVersion: 1, audio: { masterGain: 7, sfxGain: 0.5 }, display: { fullscreen: true } });
assert.deepEqual((await settings.load()).audio, { masterGain: 1, sfxGain: 0.5 });

// File storage: atomic writes, safe keys.
const dir = await mkdtemp(join(tmpdir(), "kinetra-save-doc-"));
try {
  const saves = new JsonDocumentStore<SaveEnvelope>(new FileKeyValueStorage(dir), "saves");
  await saves.save("slot-a", migrated);
  assert.deepEqual(await saves.load("slot-a"), migrated);
  assert.deepEqual(await readdir(dir), ["slot-a.json"]);
  assert.throws(() => new FileKeyValueStorage(dir).resolveFilePath("../escape"), /Invalid storage key/);
  await saves.remove("slot-a");
  assert.equal(await saves.load("slot-a"), undefined);
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

## Proof level

Unit tests live in `packages/save-state/test` (migrations, corrupt/untrusted input, file storage atomicity and temp-file cleanup, settings) and run through the package `test` script. The player persists real saves and settings through `FileKeyValueStorage` over IPC (see [`docs/STATUS.md`](../../docs/STATUS.md) for the packaged-player proof). Cloud sync and save encryption are not implemented.
