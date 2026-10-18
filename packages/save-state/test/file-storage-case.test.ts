import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileKeyValueStorage } from "../src/file-storage.js";

// NTFS/macOS treat "Slot1.json" and "slot1.json" as one file, Linux as two. File names are
// lower-cased so slots that differ only by case are the same document everywhere.
test("slots that differ only by case resolve to one lower-cased file", () => {
  const storage = new FileKeyValueStorage(join(tmpdir(), "kinetra-save-case"));
  const lower = storage.resolveFilePath("saves:slot1");
  assert.ok(lower.endsWith("slot1.json"));
  assert.equal(storage.resolveFilePath("saves:Slot1"), lower);
  assert.equal(storage.resolveFilePath("saves:SLOT1"), lower);
  assert.ok(storage.resolveFilePath("settings:User").endsWith("settings_user.json"));
});

test("set/get/delete on Slot1 and slot1 share one document and one file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-save-case-"));
  try {
    const storage = new FileKeyValueStorage(dir);
    await storage.set("saves:Slot1", "first");
    assert.equal(await storage.get("saves:slot1"), "first");
    await storage.set("saves:slot1", "second");
    assert.equal(await storage.get("saves:Slot1"), "second");
    assert.deepEqual(await readdir(dir), ["slot1.json"]);
    await storage.delete("saves:SLOT1");
    assert.equal(await storage.get("saves:slot1"), undefined);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A save written before lower-casing (exact-case file name) must stay readable and deletable.
test("a legacy exact-case save file is still readable and deletable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-save-case-legacy-"));
  try {
    await writeFile(join(dir, "Slot9.json"), "legacy", "utf8");
    const storage = new FileKeyValueStorage(dir);
    assert.equal(await storage.get("saves:Slot9"), "legacy");
    await storage.set("saves:Slot9", "new");
    assert.equal(await storage.get("saves:Slot9"), "new");
    await storage.delete("saves:Slot9");
    assert.equal(await storage.get("saves:Slot9"), undefined);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// #558: set() must not leave the legacy exact-case file behind, also when both files already exist.
test("set removes the legacy exact-case file so only the lower-cased file remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-save-case-both-"));
  try {
    await writeFile(join(dir, "Slot1.json"), "old-upper", "utf8");
    await writeFile(join(dir, "slot1.json"), "old-lower", "utf8");
    await writeFile(join(dir, "Slot9.json"), "legacy", "utf8");
    const storage = new FileKeyValueStorage(dir);
    await storage.set("saves:Slot1", "fresh");
    await storage.set("saves:Slot9", "fresh9");
    assert.deepEqual((await readdir(dir)).sort(), ["slot1.json", "slot9.json"]);
    assert.equal(await storage.get("saves:Slot1"), "fresh");
    assert.equal(await storage.get("saves:Slot9"), "fresh9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
