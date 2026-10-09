import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { serializeProject, type ProjectDocument } from "@kinetra/project-model";

import { FileProjectStore } from "../src/store.js";

function project(name: string): ProjectDocument {
  return { schemaVersion: 1, projectId: "store-errors", name, scenes: [] };
}

async function withDir(prefix: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function leftovers(names: string[]): string[] {
  return names.filter((name) => name.includes(".tmp-"));
}

// These cover the asynchronous failure branch of FileProjectStore.save (#145 item 4): the
// existing tests only reject on the synchronous serialize error, which never enters the queue.

test("a write that fails inside the queue rejects that caller and removes its temporary file", async () => {
  await withDir("kinetra-store-werr-", async (dir) => {
    const target = join(dir, "project.json");
    // A directory at the target path makes rename(tmp, target) fail after the tmp file was written.
    await mkdir(target);
    const store = new FileProjectStore(target);

    await assert.rejects(() => store.save(project("doomed")), (error: NodeJS.ErrnoException) => {
      assert.equal(typeof error.code, "string");
      return true;
    });
    assert.deepEqual(leftovers(await readdir(dir)), [], "temporary file cleaned after a failed rename");
  });
});

test("a failing write in the middle of overlapping saves does not poison its neighbours", async () => {
  await withDir("kinetra-store-mid-", async (dir) => {
    const target = join(dir, "project.json");
    const store = new FileProjectStore(target);
    await store.save(project("seed"));

    // Swap the file for a directory so the next write fails, then restore it before the third save runs.
    // Saves run one after another, so we drive the order by awaiting the failing one first.
    await rm(target);
    await mkdir(target);
    const failing = store.save(project("fails"));
    const failure = assert.rejects(() => failing);
    const queuedAfter = store.save(project("queued-after-failure"));
    await failure;
    // The queued save started after the failure; it also hits the directory and must fail on its own,
    // proving the chain keeps running rather than hanging on the earlier rejection.
    await assert.rejects(() => queuedAfter);

    await rm(target, { recursive: true });
    await store.save(project("recovered"));
    assert.equal((await store.load()).name, "recovered");
    assert.deepEqual(leftovers(await readdir(dir)), []);
  });
});

test("one rejected save is reported only to its own caller; later saves in the same tick still land", async () => {
  await withDir("kinetra-store-own-", async (dir) => {
    const target = join(dir, "project.json");
    const store = new FileProjectStore(target);

    const bad = store.save({ ...project("x"), name: "" }); // sync serialize failure
    const good = store.save(project("good"));
    await assert.rejects(() => bad);
    await good;
    assert.equal((await store.load()).name, "good");
  });
});

test("mkdir failure (parent is a regular file) rejects with a filesystem error and leaves the file alone", async () => {
  await withDir("kinetra-store-parent-", async (dir) => {
    const parent = join(dir, "not-a-dir");
    await writeFile(parent, "plain file", "utf8");
    const store = new FileProjectStore(join(parent, "project.json"));

    await assert.rejects(() => store.save(project("never")), (error: NodeJS.ErrnoException) => {
      assert.ok(error.code === "ENOTDIR" || error.code === "EEXIST", `unexpected code ${error.code}`);
      return true;
    });
    assert.equal(await readFile(parent, "utf8"), "plain file");
    // The chain survives: a save to a sane location with the same store type still works.
    const other = new FileProjectStore(join(dir, "ok", "project.json"));
    await other.save(project("fine"));
    assert.equal((await other.load()).name, "fine");
  });
});

test("a save that fails to serialize leaves the existing project file and directory untouched", async () => {
  await withDir("kinetra-store-atomic-", async (dir) => {
    const target = join(dir, "project.json");
    await writeFile(target, serializeProject(project("original")), "utf8");
    const store = new FileProjectStore(target);

    // A save whose serialization fails never reaches the filesystem at all.
    await assert.rejects(() => store.save({ ...project("x"), name: "" }));
    assert.equal((await store.load()).name, "original");
    assert.deepEqual(leftovers(await readdir(dir)), []);
  });
});

test("load rejects for a missing file and for corrupt JSON instead of returning a partial document", async () => {
  await withDir("kinetra-store-load-", async (dir) => {
    const missing = new FileProjectStore(join(dir, "missing.json"));
    await assert.rejects(() => missing.load(), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const corruptPath = join(dir, "corrupt.json");
    await writeFile(corruptPath, '{"schemaVersion": 1, "projectId": ', "utf8");
    await assert.rejects(() => new FileProjectStore(corruptPath).load());

    const emptyPath = join(dir, "empty.json");
    await writeFile(emptyPath, "", "utf8");
    await assert.rejects(() => new FileProjectStore(emptyPath).load());
  });
});
