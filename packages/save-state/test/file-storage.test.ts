import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
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

test("FileKeyValueStorage lists save slots and excludes settings files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-save-test-"));

  try {
    const missing = new FileKeyValueStorage(join(tempDir, "missing"));
    assert.deepEqual(await missing.list("saves"), []);

    const storage = new FileKeyValueStorage(tempDir);
    await storage.set("saves:slot-b", "{}");
    await storage.set("saves:slot-a", "{}");
    await storage.set("settings:user", "{}");
    await writeFile(join(tempDir, "not safe.json"), "{}");
    await writeFile(join(tempDir, "slot-a.json.tmp.1"), "partial");
    await mkdir(join(tempDir, "nested.json"));

    assert.deepEqual(await storage.list("saves"), ["slot-a", "slot-b"]);
    assert.deepEqual(await storage.list("settings"), ["user"]);
    assert.deepEqual(await storage.list("notes"), []);

    await storage.delete("saves:slot-b");
    assert.deepEqual(await storage.list("saves"), ["slot-a"]);

    await assert.rejects(() => storage.list("../saves"), /prefix/i);
    await assert.rejects(() => storage.list(""), /prefix/i);
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

test("FileKeyValueStorage preserves old save and cleans up temp file when replacement fails", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-save-fail-test-"));

  try {
    const originalPayload = JSON.stringify({ version: 1, state: "VALID_SAVE_A" });
    const storage = new FileKeyValueStorage(tempDir);

    // Initial save
    await storage.set("slot-fail-test", originalPayload);
    assert.equal(await storage.get("slot-fail-test"), originalPayload);

    // Storage configured with a renameFile primitive that always throws to simulate replacement failure
    const failingStorage = new FileKeyValueStorage(tempDir, {
      renameRetryAttempts: 1,
      retryDelayMs: 5,
      renameFile: async () => {
        throw new Error("EPERM: simulated atomic replacement lock failure");
      },
    });

    const newPayload = JSON.stringify({ version: 2, state: "CORRUPT_NEW_SAVE" });

    // Expect set() to reject with the simulated failure
    await assert.rejects(
      () => failingStorage.set("slot-fail-test", newPayload),
      /EPERM: simulated atomic replacement lock failure/,
    );

    // INVARIANT 1: The old valid save file still exists and matches VALID_SAVE_A exactly
    const afterFailedSet = await storage.get("slot-fail-test");
    assert.equal(afterFailedSet, originalPayload, "Old valid save must remain untouched");

    // INVARIANT 2: No partially written or temporary files remain in storage directory
    const files = await readdir(tempDir);
    assert.deepEqual(
      files,
      ["slot-fail-test.json"],
      "Temporary files must be safely cleaned up and only original save remains",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

