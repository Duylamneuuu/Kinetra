import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileKeyValueStorage } from "../src/file-storage.js";
import {
  IpcKeyValueStorage,
  MemoryStorage,
  SettingsStore,
  type PlatformStorageBridge,
} from "../src/index.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-storage-contract-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("FileKeyValueStorage constructor rejects an empty or non-string root directory", () => {
  assert.throws(() => new FileKeyValueStorage(""), TypeError);
  assert.throws(() => new FileKeyValueStorage(undefined as unknown as string), TypeError);
  assert.throws(() => new FileKeyValueStorage(42 as unknown as string), TypeError);
});

test("resolveFilePath rejects empty and non-string keys before touching the disk", () => {
  const storage = new FileKeyValueStorage(join(tmpdir(), "kinetra-never-created"));
  for (const key of ["", undefined, null, 7, {}] as unknown[]) {
    assert.throws(() => storage.resolveFilePath(key as string), TypeError, `key ${String(key)}`);
  }
});

test("every key spelling that could leave the root or break the file-name grammar is rejected", () => {
  const storage = new FileKeyValueStorage(join(tmpdir(), "kinetra-never-created"));
  const hostile = [
    "../escape",
    "..",
    ".",
    "a/b",
    "a\\b",
    "saves:../x",
    "saves:a/b",
    "settings:../x",
    "saves:",
    "saves: slot",
    ".hidden",
    "trailing.",
    "a..b",
    "a b",
    "slot\0name",
    "slot\nname",
    "ünïcode",
  ];
  for (const key of hostile) {
    assert.throws(() => storage.resolveFilePath(key), /Invalid storage key/, `key ${JSON.stringify(key)}`);
  }
});

test("property: every accepted key resolves to a single .json file directly inside the root", () => {
  const root = join(tmpdir(), "kinetra-never-created");
  const storage = new FileKeyValueStorage(root);
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = "abcXYZ019_-./\\: ~%\0";
  let accepted = 0;
  for (let i = 0; i < 2000; i++) {
    const length = 1 + (next() % 10);
    let key = next() % 3 === 0 ? "saves:" : next() % 5 === 0 ? "settings:" : "";
    for (let c = 0; c < length; c++) key += alphabet[next() % alphabet.length];
    let path: string;
    try {
      path = storage.resolveFilePath(key);
    } catch {
      continue;
    }
    accepted++;
    assert.ok(path.endsWith(".json"), key);
    const relative = path.slice(storage.rootDir.length + 1);
    assert.ok(path.startsWith(storage.rootDir), key);
    assert.ok(!/[\\/]/.test(relative), `key ${JSON.stringify(key)} escaped into a sub-path: ${relative}`);
  }
  assert.ok(accepted > 100, "the generator should exercise plenty of accepted keys");
});

test("set rejects non-string values without creating the root or any file", async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, "not-created-yet");
    const storage = new FileKeyValueStorage(root);
    for (const value of [undefined, null, 1, {}, ["x"], Buffer.from("x")] as unknown[]) {
      await assert.rejects(() => storage.set("saves:slot", value as string), TypeError);
    }
    await assert.rejects(() => readdir(root), { code: "ENOENT" });
  });
});

test("delete of a missing key is a no-op and keeps other keys", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileKeyValueStorage(dir);
    await storage.delete("saves:ghost");
    await storage.set("saves:kept", "1");
    await storage.delete("saves:ghost");
    assert.equal(await storage.get("saves:kept"), "1");
  });
});

test("get and delete surface non-ENOENT filesystem errors instead of pretending the key is missing", async () => {
  await withTempDir(async (dir) => {
    // A directory squatting on the file name makes read/unlink fail with EISDIR / EPERM, not ENOENT.
    await mkdir(join(dir, "squatter.json"));
    const storage = new FileKeyValueStorage(dir);
    await assert.rejects(() => storage.get("saves:squatter"), (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
    await assert.rejects(() => storage.delete("saves:squatter"), (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
  });
});

test("set overwrites an existing value and leaves exactly one file behind", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileKeyValueStorage(dir);
    await writeFile(join(dir, "slot.json"), "old", "utf8");
    await storage.set("saves:slot", "new");
    assert.equal(await storage.get("saves:slot"), "new");
    assert.deepEqual(await readdir(dir), ["slot.json"]);
  });
});

test("IpcKeyValueStorage forwards every call to the bridge verbatim and propagates bridge errors", async () => {
  const calls: unknown[][] = [];
  const bridge: PlatformStorageBridge = {
    async storageGet(key) {
      calls.push(["get", key]);
      return key === "saves:present" ? "value" : undefined;
    },
    async storageSet(key, value) {
      calls.push(["set", key, value]);
      if (key === "saves:boom") throw new Error("ipc down");
    },
    async storageDelete(key) {
      calls.push(["delete", key]);
    },
  };
  const storage = new IpcKeyValueStorage(bridge);
  assert.equal(await storage.get("saves:present"), "value");
  assert.equal(await storage.get("saves:absent"), undefined);
  await storage.set("saves:a", "1");
  await storage.delete("saves:a");
  await assert.rejects(() => storage.set("saves:boom", "x"), /ipc down/);
  assert.deepEqual(calls, [
    ["get", "saves:present"],
    ["get", "saves:absent"],
    ["set", "saves:a", "1"],
    ["delete", "saves:a"],
    ["set", "saves:boom", "x"],
  ]);
});

test("SettingsStore.remove restores defaults and only touches the named key", async () => {
  const memory = new MemoryStorage();
  const store = new SettingsStore(memory);
  const defaults = await store.load();
  await store.save({ ...defaults, audio: { ...defaults.audio, masterGain: 0.25 } });
  await store.save({ ...defaults, audio: { ...defaults.audio, masterGain: 0.5 } }, "profile-b");
  await store.remove();
  assert.deepEqual(await store.load(), defaults);
  assert.equal((await store.load("profile-b")).audio.masterGain, 0.5);
  // Removing something that was never saved is not an error.
  await store.remove("never-saved");
});
