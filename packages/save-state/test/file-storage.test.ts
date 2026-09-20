import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileKeyValueStorage } from "../src/file-storage.js";

test("FileKeyValueStorage sets, gets, and deletes keys", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-save-test-"));

  try {
    const storage = new FileKeyValueStorage(tempDir);

    // Initial get returns undefined
    const initial = await storage.get("saves:slot-1");
    assert.equal(initial, undefined);

    // Set value
    const payload = JSON.stringify({ schemaVersion: 2, test: "data" });
    await storage.set("saves:slot-1", payload);

    // Get value
    const retrieved = await storage.get("saves:slot-1");
    assert.equal(retrieved, payload);

    // Verify temp files are cleaned up
    const files = await readdir(tempDir);
    assert.deepEqual(files, ["slot-1.json"]);

    // Delete value
    await storage.delete("saves:slot-1");
    const afterDelete = await storage.get("saves:slot-1");
    assert.equal(afterDelete, undefined);

    // Deleting again does not throw
    await storage.delete("saves:slot-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FileKeyValueStorage rejects path traversal and invalid characters", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-save-test-"));

  try {
    const storage = new FileKeyValueStorage(tempDir);

    const traversalKeys = [
      "../../escape",
      "..\\..\\escape",
      "/absolute/path",
      "C:\\Windows\\System32",
      "slot/with/subfolder",
      "slot\\sub",
      "slot with spaces",
      "slot$bad",
      "",
    ];

    for (const badKey of traversalKeys) {
      assert.throws(
        () => storage.resolveFilePath(badKey),
        /invalid|illegal|traversal|non-empty/i,
        `Expected bad key "${badKey}" to be rejected`,
      );

      await assert.rejects(
        () => storage.get(badKey),
        /invalid|illegal|traversal|non-empty/i,
      );

      await assert.rejects(
        () => storage.set(badKey, "val"),
        /invalid|illegal|traversal|non-empty/i,
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("FileKeyValueStorage performs atomic replacement when overwriting", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-save-test-"));

  try {
    const storage = new FileKeyValueStorage(tempDir);

    await storage.set("slot-a", JSON.stringify({ version: 1 }));
    assert.equal(
      JSON.parse((await storage.get("slot-a"))!).version,
      1,
    );

    // Overwrite
    await storage.set("slot-a", JSON.stringify({ version: 2 }));
    assert.equal(
      JSON.parse((await storage.get("slot-a"))!).version,
      2,
    );

    const files = await readdir(tempDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], "slot-a.json");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
