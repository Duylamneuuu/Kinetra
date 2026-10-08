import assert from "node:assert/strict";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileKeyValueStorage } from "../src/file-storage.js";

test("FileKeyValueStorage removes the temp file when write/sync fails and keeps the old save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-save-leak-"));
  try {
    await new FileKeyValueStorage(dir).set("saves:slot-1", "old");
    const failing = new FileKeyValueStorage(dir, {
      openFile: (async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1]) => {
        const handle = await open(path, flags);
        handle.sync = async () => {
          throw new Error("ENOSPC simulated");
        };
        return handle;
      }) as typeof open,
    });
    await assert.rejects(() => failing.set("saves:slot-1", "new"), /ENOSPC simulated/);
    assert.deepEqual(await readdir(dir), ["slot-1.json"]);
    assert.equal(await new FileKeyValueStorage(dir).get("saves:slot-1"), "old");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
