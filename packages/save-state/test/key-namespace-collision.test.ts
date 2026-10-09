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
