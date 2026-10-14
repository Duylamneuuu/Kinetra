import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileKeyValueStorage } from "../src/file-storage.js";

// "settings:user" is stored as settings_user.json; a save slot literally named "settings_user"
// used to map to the very same file, so saving the slot silently overwrote the player's settings.
test("a save slot cannot alias the file backing a settings key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-save-collision-"));
  try {
    const storage = new FileKeyValueStorage(dir);
    await storage.set("settings:user", '{"schemaVersion":1}');
    await assert.rejects(
      () => storage.set("saves:settings_user", '{"slot":"data"}'),
      /Invalid storage key "saves:settings_user"/,
    );
    assert.equal(await storage.get("settings:user"), '{"schemaVersion":1}');
    assert.throws(() => storage.resolveFilePath("saves:settings_user"), /settings_/);
    // Ordinary slots and settings keys keep their on-disk names.
    assert.ok(storage.resolveFilePath("saves:slot-a").endsWith("slot-a.json"));
    assert.ok(storage.resolveFilePath("settings:user").endsWith("settings_user.json"));
    assert.ok(storage.resolveFilePath("saves:settingsfoo").endsWith("settingsfoo.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Windows (NTFS) and macOS resolve file names case-insensitively, so "Settings_user.json" is "settings_user.json":
// the namespace guard has to ignore case too, or a slot named "Settings_user" overwrites the player's settings.
test("a save slot cannot alias a settings file by changing the case of its prefix", () => {
  const storage = new FileKeyValueStorage(join(tmpdir(), "kinetra-save-collision-case"));
  for (const slot of ["Settings_user", "SETTINGS_user", "sEtTiNgS_x"]) {
    assert.throws(() => storage.resolveFilePath(`saves:${slot}`), /settings_/i, slot);
  }
  // Names that merely resemble the prefix stay usable.
  assert.ok(storage.resolveFilePath("saves:Settings-user").endsWith("settings-user.json"));
  assert.ok(storage.resolveFilePath("saves:Settingsfoo").endsWith("settingsfoo.json"));
});
