import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AssetDatabase,
  AssetReimportService,
  GlbDirectImporter,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  type AssetImporter,
  type AssetRecord,
  type FileSystemAdapter,
  type ReimportEvent,
} from "../src/index.js";

const enc = (text: string) => new TextEncoder().encode(text);

/** In-memory file system with switchable failures; records every call so tests can check cleanup. */
function memoryFs(files: Map<string, Uint8Array>) {
  const calls: string[] = [];
  const failures = { write: false, rename: false, mkdir: false };
  const fs: FileSystemAdapter = {
    async readFile(path) {
      calls.push(`read ${path}`);
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT ${path}`);
      return bytes.slice();
    },
    async writeFile(path, data) {
      calls.push(`write ${path}`);
      if (failures.write) throw new Error("disk full");
      files.set(path, data.slice());
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      if (failures.rename) throw new Error("EBUSY");
      const bytes = files.get(from);
      if (!bytes) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, bytes);
    },
    async unlink(path) {
      calls.push(`unlink ${path}`);
      files.delete(path);
    },
    async mkdir(path) {
      calls.push(`mkdir ${path}`);
      if (failures.mkdir) throw new Error("EACCES");
      return undefined;
    },
  };
  return { fs, calls, failures };
}

function makeRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
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
    metadata: { polycount: 5 },
    ...overrides,
  };
}

const rawImporter: AssetImporter = {
  async import(context) {
    return { artifactBytes: context.sourceBytes, metadata: { polycount: 9 }, diagnostics: [] };
  },
};

function setup(record: AssetRecord = makeRecord(), importers?: Map<string, AssetImporter>) {
  const files = new Map<string, Uint8Array>([[record.source.path, enc("v1")]]);
  const mem = memoryFs(files);
  const database = new AssetDatabase();
  database.upsert(record);
  const events: ReimportEvent[] = [];
  const service = new AssetReimportService({
    database,
    importers: importers ?? new Map([["raw", rawImporter]]),
    fileSystem: mem.fs,
    onEvent: (event) => events.push(event),
  });
  return { files, mem, database, events, service };
}

test("reimporting an asset that is not in the database fails with a structured result and event", async () => {
  const { service, events } = setup();
  const result = await service.reimport("ghost");
  assert.equal(result.status, "failed");
  assert.deepEqual(result.affectedAssetIds, []);
  assert.match(result.error ?? "", /"ghost" does not exist/);
  assert.deepEqual(events.map((e) => [e.type, e.assetId]), [["asset.reimportFailed", "ghost"]]);
});

test("a missing source file fails before anything is written or the record changes", async () => {
  const { service, files, mem, database, events } = setup();
  files.delete("src/hero.txt");
  const before = database.get("hero");
  const result = await service.reimport("hero");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Failed to read source file at "src\/hero.txt": ENOENT/);
  assert.deepEqual(database.get("hero"), before);
  assert.ok(!mem.calls.some((call) => call.startsWith("write") || call.startsWith("rename")));
  assert.deepEqual(events.map((e) => e.type), ["asset.reimportFailed"]);
});

test("an unregistered importer fails after reimportStarted and leaves the record untouched", async () => {
  const { service, database, events } = setup(makeRecord(), new Map());
  const before = database.get("hero");
  const result = await service.reimport("hero");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /No importer registered for recipe importer "raw"/);
  assert.deepEqual(database.get("hero"), before);
  assert.deepEqual(events.map((e) => e.type), ["asset.reimportStarted", "asset.reimportFailed"]);
});

test("registerImporter makes a previously failing asset importable, and getImporter reflects it", async () => {
  const { service } = setup(makeRecord(), new Map());
  assert.equal(service.getImporter("raw"), undefined);
  assert.ok(service.getImporter("glb") instanceof GlbDirectImporter);
  assert.ok(service.getImporter("direct-glb") instanceof GlbDirectImporter);
  assert.ok(service.getImporter("passthrough") instanceof GlbDirectImporter);
  assert.equal((await service.reimport("hero")).status, "failed");
  service.registerImporter("raw", rawImporter);
  assert.equal(service.getImporter("raw"), rawImporter);
  assert.equal((await service.reimport("hero")).status, "reimported");
});

test("a caller-supplied importer can replace a built-in one", () => {
  const custom: AssetImporter = { import: async (c) => ({ artifactBytes: c.sourceBytes }) };
  const { service } = setup(makeRecord(), new Map([["glb", custom]]));
  assert.equal(service.getImporter("glb"), custom);
  assert.ok(service.getImporter("passthrough") instanceof GlbDirectImporter);
});

test("a throwing importer removes its temp file and keeps the last known-good artifact", async () => {
  const boom: AssetImporter = {
    async import() {
      throw new Error("importer exploded");
    },
  };
  const { service, files, mem, database } = setup(makeRecord(), new Map([["raw", boom]]));
  files.set("out/hero.bin", enc("good"));
  const before = database.get("hero");
  const result = await service.reimport("hero");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Import or validation failed for asset "hero": importer exploded/);
  assert.deepEqual(database.get("hero"), before);
  assert.equal(new TextDecoder().decode(files.get("out/hero.bin")), "good");
  assert.ok(mem.calls.some((call) => call.startsWith("unlink out/hero.tmp.")), "temp path is cleaned up");
  assert.deepEqual([...files.keys()].sort(), ["out/hero.bin", "src/hero.txt"]);
});

test("a non-error throw from the importer is reported as text", async () => {
  const weird: AssetImporter = {
    async import() {
      throw "plain string"; // eslint-disable-line no-throw-literal
    },
  };
  const { service } = setup(makeRecord(), new Map([["raw", weird]]));
  const result = await service.reimport("hero");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /plain string/);
});

test("model assets must produce a valid GLB; other kinds are not inspected", async () => {
  const notGlb: AssetImporter = { import: async () => ({ artifactBytes: enc("this is not a glb at all") }) };

  const model = setup(makeRecord({ kind: "model" }), new Map([["raw", notGlb]]));
  const rejected = await model.service.reimport("hero");
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error ?? "", /GLB is smaller|Invalid GLB magic/);
  assert.equal(model.files.has("out/hero.bin"), false, "nothing was published");

  const other = setup(makeRecord({ kind: "other" }), new Map([["raw", notGlb]]));
  assert.equal((await other.service.reimport("hero")).status, "reimported");
});

test("a real GLB passes through the built-in importer and records its dimensions", async () => {
  const glb = await createSyntheticGlb();
  const record = makeRecord({
    kind: "model",
    recipe: { importer: "glb", importerVersion: "1", settings: {} },
  });
  const { service, files, database } = setup(record, new Map());
  files.set("src/hero.txt", glb);
  const result = await service.reimport("hero");
  assert.equal(result.status, "reimported");
  assert.deepEqual(files.get("out/hero.bin"), glb);
  assert.deepEqual(database.get("hero")?.metadata.dimensions, [1, 1, 1]);
  assert.equal(database.get("hero")?.source.contentHash, hashBytes(glb));
});

test("write and rename failures clean up the temp file and leave the database unchanged", async () => {
  for (const failure of ["write", "rename", "mkdir"] as const) {
    const { service, mem, files, database, events } = setup();
    mem.failures[failure] = true;
    const before = database.get("hero");
    const result = await service.reimport("hero");
    assert.equal(result.status, "failed", failure);
    assert.match(result.error ?? "", /Failed to atomically write imported artifact to "out\/hero\.bin"/, failure);
    assert.deepEqual(database.get("hero"), before, failure);
    assert.equal(files.has("out/hero.bin"), false, failure);
    assert.deepEqual([...files.keys()], ["src/hero.txt"], `${failure}: no temp file left behind`);
    assert.equal(events.at(-1)?.type, "asset.reimportFailed", failure);
  }
});

test("an unchanged asset whose imported artifact was deleted is rebuilt instead of reported as noop", async () => {
  const { service, files, database } = setup();
  const first = await service.reimport("hero");
  assert.equal(first.status, "reimported");
  assert.equal((await service.reimport("hero")).status, "noop");

  files.delete("out/hero.bin");
  const healed = await service.reimport("hero");
  assert.equal(healed.status, "reimported");
  assert.equal(healed.oldFingerprint, healed.newFingerprint, "same inputs, same fingerprint");
  assert.ok(files.has("out/hero.bin"));
  assert.equal(database.get("hero")?.fingerprint, first.fingerprint);
});

test("a noop result reports the stored fingerprint and emits only reimportNoop", async () => {
  const { service, events } = setup();
  await service.reimport("hero");
  events.length = 0;
  const result = await service.reimport("hero");
  assert.equal(result.status, "noop");
  assert.deepEqual(result.affectedAssetIds, []);
  assert.equal(result.fingerprint, result.oldFingerprint);
  assert.equal(result.fingerprint, result.newFingerprint);
  assert.deepEqual(events.map((e) => e.type), ["asset.reimportNoop"]);
});

test("changing a dependency's fingerprint makes the dependent reimport even though its source is unchanged", async () => {
  const dep = makeRecord({ id: "dep", source: { path: "src/dep.txt", kind: "source", contentHash: hashBytes(enc("d0")) }, importedPath: "out/dep.bin" });
  const user = makeRecord({ id: "user", dependencies: ["dep"], source: { path: "src/user.txt", kind: "source", contentHash: hashBytes(enc("u0")) }, importedPath: "out/user.bin" });
  const { service, files, database } = setup(dep, new Map([["raw", rawImporter]]));
  database.upsert(user);
  files.set("src/dep.txt", enc("d0"));
  files.set("src/user.txt", enc("u0"));

  // Bring both in sync with their current sources (fingerprints now include the dependency's).
  await service.reimportWithDependents("dep");
  assert.equal((await service.reimport("user")).status, "noop");

  files.set("src/dep.txt", enc("d1"));
  const cascade = await service.reimportWithDependents("dep");
  assert.equal(cascade.status, "reimported");
  assert.deepEqual(cascade.rebuiltAssetIds, ["dep", "user"]);
  assert.deepEqual(cascade.blockedAssetIds, []);
  assert.deepEqual(files.get("out/user.bin"), enc("u0"), "dependent artifact rewritten with its own source");
});

test("a listener that throws does not stop other listeners or the reimport", async () => {
  const { service } = setup();
  const seen: string[] = [];
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    service.onEvent(() => {
      throw new Error("bad listener");
    });
    service.onEvent((event) => seen.push(event.type));
    const result = await service.reimport("hero");
    assert.equal(result.status, "reimported");
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ["asset.reimportStarted", "asset.reimportSucceeded"]);
  assert.ok(logged.length >= 2, "each throw is logged, not swallowed silently");
});

test("the unsubscribe function returned by onEvent stops delivery to that listener only", async () => {
  const { service, events } = setup();
  const extra: string[] = [];
  const off = service.onEvent((event) => extra.push(event.type));
  await service.reimport("hero");
  const delivered = extra.length;
  assert.ok(delivered > 0);
  off();
  off(); // idempotent
  events.length = 0;
  await service.reimport("hero");
  assert.equal(extra.length, delivered);
  assert.ok(events.length > 0, "the constructor listener is still attached");
});

test("reimporting emits asset.invalidated for every transitive dependent, and affectedAssetIds lists the root first", async () => {
  const mk = (id: string, dependencies: string[]) =>
    makeRecord({ id, dependencies, source: { path: `src/${id}.txt`, kind: "source", contentHash: hashBytes(enc("x")) }, importedPath: `out/${id}.bin` });
  const { service, database, events, files } = setup(mk("a", []));
  database.upsert(mk("b", ["a"]));
  database.upsert(mk("c", ["b"]));
  database.upsert(mk("z", []));
  files.set("src/a.txt", enc("a1"));
  const result = await service.reimport("a");
  assert.equal(result.status, "reimported");
  assert.deepEqual(result.affectedAssetIds, ["a", "b", "c"]);
  assert.deepEqual(events.filter((e) => e.type === "asset.invalidated").map((e) => e.assetId), ["b", "c"]);
});

test("reimportWithDependents on an unknown root fails without throwing and blocks nothing", async () => {
  const { service } = setup();
  const result = await service.reimportWithDependents("ghost");
  assert.equal(result.status, "failed");
  assert.equal(result.failedAssetId, "ghost");
  assert.deepEqual(result.rebuildOrder, ["ghost"]);
  assert.deepEqual(result.blockedAssetIds, []);
  assert.deepEqual(result.unaffectedAssetIds, ["hero"]);
  assert.equal(result.oldSourceHash, undefined);
});

test("reimportWithDependents reports a noop root with its stored hashes and every other asset as unaffected", async () => {
  const { service, database } = setup();
  await service.reimport("hero");
  const stored = database.get("hero");
  const result = await service.reimportWithDependents("hero");
  assert.equal(result.status, "noop");
  assert.deepEqual(result.rebuildOrder, ["hero"]);
  assert.deepEqual(result.rebuiltAssetIds, []);
  assert.equal(result.oldFingerprint, stored?.fingerprint);
  assert.equal(result.newFingerprint, stored?.fingerprint);
  assert.equal(result.newSourceHash, stored?.source.contentHash);
});

test("the default Node file system creates missing directories, replaces atomically and leaves no temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-reimport-edge-"));
  try {
    const glb = await createSyntheticGlb();
    const sourcePath = join(dir, "source", "hero.glb");
    const importedPath = join(dir, "imported", "nested", "hero.glb");
    await mkdir(join(dir, "source"), { recursive: true });
    await writeFile(sourcePath, glb);

    const recipe = { importer: "glb", importerVersion: "1", settings: {} };
    const database = new AssetDatabase();
    database.upsert({
      id: "hero",
      kind: "model",
      source: { path: sourcePath, kind: "source", contentHash: "0".repeat(64) },
      importedPath,
      recipe,
      fingerprint: "1".repeat(64),
      dependencies: [],
      diagnostics: [],
      metadata: {},
    });
    const service = new AssetReimportService({ database });
    const result = await service.reimport("hero");
    assert.equal(result.status, "reimported");
    assert.deepEqual(new Uint8Array(await readFile(importedPath)), glb);
    assert.deepEqual(await readdir(join(dir, "imported", "nested")), ["hero.glb"]);
    assert.equal((await service.reimport("hero")).status, "noop");

    // A corrupt source must not damage the published artifact.
    await writeFile(sourcePath, enc("corrupt"));
    const failed = await service.reimport("hero");
    assert.equal(failed.status, "failed");
    assert.deepEqual(new Uint8Array(await readFile(importedPath)), glb);
    assert.deepEqual(await readdir(join(dir, "imported", "nested")), ["hero.glb"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
