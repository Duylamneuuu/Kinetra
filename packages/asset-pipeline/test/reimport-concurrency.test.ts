import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetDatabase,
  AssetReimportService,
  hashBytes,
  importFingerprint,
  type AssetRecord,
  type FileSystemAdapter,
  type ReimportEvent,
} from "../src/index.js";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** In-memory file system whose first source read can be held back until `release()`. */
function memoryFs(files: Map<string, Uint8Array>) {
  let gate: Promise<void> | undefined;
  let release: () => void = () => {};
  let sourceReads = 0;
  const fs: FileSystemAdapter = {
    async readFile(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT ${path}`);
      const snapshot = bytes.slice();
      if (path === "src/hero.txt") {
        sourceReads++;
        if (sourceReads === 1 && gate) await gate;
      }
      return snapshot;
    },
    async writeFile(path, data) {
      files.set(path, data.slice());
    },
    async rename(from, to) {
      const bytes = files.get(from);
      if (!bytes) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, bytes);
    },
    async unlink(path) {
      files.delete(path);
    },
    async mkdir() {
      return undefined;
    },
  };
  return {
    fs,
    holdFirstSourceRead() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}

function makeRecord(): AssetRecord {
  const recipe = { importer: "raw", importerVersion: "1", settings: {} };
  const sourceHash = hashBytes(enc("v0"));
  return {
    id: "hero",
    kind: "other",
    source: { path: "src/hero.txt", kind: "source", contentHash: sourceHash },
    importedPath: "out/hero.bin",
    recipe,
    fingerprint: importFingerprint({ sourceHash, ...recipe }),
    dependencies: [],
    diagnostics: [],
    metadata: {},
  };
}

function makeService(files: Map<string, Uint8Array>, fs: FileSystemAdapter, events: ReimportEvent[] = []) {
  const database = new AssetDatabase();
  database.upsert(makeRecord());
  const service = new AssetReimportService({
    database,
    fileSystem: fs,
    importers: new Map([
      [
        "raw",
        {
          async import(context) {
            // Yield so an overlapping reimport has the chance to interleave with this one.
            await settle();
            return { artifactBytes: context.sourceBytes };
          },
        },
      ],
    ]),
    onEvent: (event) => events.push(event),
  });
  return { database, service };
}

test("overlapping reimports of one asset never leave an older source's artifact behind", async () => {
  const files = new Map<string, Uint8Array>([["src/hero.txt", enc("v1")]]);
  const mem = memoryFs(files);
  const { database, service } = makeService(files, mem.fs);

  // First reimport reads v1 and then stalls; the source is edited to v2 and a second
  // reimport starts. Whatever the interleaving, the last state must describe v2.
  mem.holdFirstSourceRead();
  const first = service.reimport("hero");
  await settle();
  files.set("src/hero.txt", enc("v2"));
  const second = service.reimport("hero");
  await settle();
  mem.release();
  await Promise.all([first, second]);

  const record = database.get("hero")!;
  assert.equal(dec(files.get("out/hero.bin")!), "v2", "artifact on disk is from the stale v1 read");
  assert.equal(record.source.contentHash, hashBytes(enc("v2")), "database records the stale v1 source hash");
  assert.equal(
    record.fingerprint,
    importFingerprint({ sourceHash: hashBytes(enc("v2")), ...record.recipe }),
    "database fingerprint belongs to the stale v1 import",
  );
});

test("overlapping reimports of one asset run one after another and the later one sees the earlier result", async () => {
  const files = new Map<string, Uint8Array>([["src/hero.txt", enc("v1")]]);
  const mem = memoryFs(files);
  const events: ReimportEvent[] = [];
  const { service } = makeService(files, mem.fs, events);

  const [a, b] = await Promise.all([service.reimport("hero"), service.reimport("hero")]);

  // Same unchanged source: exactly one real import, the second call is a no-op.
  assert.deepEqual([a.status, b.status], ["reimported", "noop"]);
  assert.equal(events.filter((event) => event.type === "asset.reimportStarted").length, 1);
});

test("reimports of different assets are not serialized behind each other", async () => {
  const files = new Map<string, Uint8Array>([
    ["src/hero.txt", enc("v1")],
    ["src/other.txt", enc("o1")],
  ]);
  const mem = memoryFs(files);
  const { database, service } = makeService(files, mem.fs);
  const other = makeRecord();
  other.id = "other";
  other.source.path = "src/other.txt";
  other.importedPath = "out/other.bin";
  database.upsert(other);

  mem.holdFirstSourceRead();
  const held = service.reimport("hero");
  await settle();
  const free = await service.reimport("other");
  assert.equal(free.status, "reimported", "an unrelated asset must not wait for a stalled one");
  mem.release();
  assert.equal((await held).status, "reimported");
});
