import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetDatabase,
  AssetHotReloadCoordinator,
  AssetReimportService,
  DEFAULT_MAX_TRANSACTION_HISTORY,
  hashBytes,
  importFingerprint,
  type AssetImporter,
  type AssetRecord,
  type FileSystemAdapter,
  type SourceAssetWatcher,
} from "../src/index.js";

const enc = (text: string) => new TextEncoder().encode(text);

const rawImporter: AssetImporter = {
  async import(context) {
    return { artifactBytes: context.sourceBytes };
  },
};

function memoryFs(files: Map<string, Uint8Array>): FileSystemAdapter {
  return {
    async readFile(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT ${path}`);
      return bytes.slice();
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
}

function setup(maxTransactionHistory?: number) {
  const recipe = { importer: "raw", importerVersion: "1", settings: {} };
  const sourceHash = hashBytes(enc("hero-initial"));
  const hero: AssetRecord = {
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
  const files = new Map<string, Uint8Array>();
  const fs = memoryFs(files);
  const database = new AssetDatabase();
  database.upsert(hero);
  const reimportService = new AssetReimportService({ database, importers: new Map([["raw", rawImporter]]), fileSystem: fs });
  const watcher = {
    onEvent: () => () => {},
    async start() {},
    async stop() {},
  } as unknown as SourceAssetWatcher;
  const coordinator = new AssetHotReloadCoordinator({
    database,
    reimportService,
    watcher,
    fileSystem: fs,
    ...(maxTransactionHistory !== undefined ? { maxTransactionHistory } : {}),
  });
  async function edit(version: number) {
    files.set("src/hero.txt", enc(`hero-v${version}`));
    const tx = await coordinator.processAssetChange("hero");
    assert.ok(tx, `edit ${version} produces a transaction`);
    return tx;
  }
  return { coordinator, edit };
}

test("the transaction history keeps only the newest maxTransactionHistory entries", async () => {
  const { coordinator, edit } = setup(3);
  const txs = [];
  for (let version = 1; version <= 7; version++) txs.push(await edit(version));
  const history = coordinator.getTransactionHistory();
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((tx) => tx.newSourceHash), txs.slice(-3).map((tx) => tx.newSourceHash));
  assert.strictEqual(history[2], txs[6]);
});

test("the history is bounded by default so a long hot-reload session cannot grow without limit", async () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_TRANSACTION_HISTORY) && DEFAULT_MAX_TRANSACTION_HISTORY >= 1);
  const { coordinator, edit } = setup();
  for (let version = 1; version <= DEFAULT_MAX_TRANSACTION_HISTORY + 20; version++) await edit(version);
  assert.equal(coordinator.getTransactionHistory().length, DEFAULT_MAX_TRANSACTION_HISTORY);
});

test("waitForAssetReload still resolves when the history is bounded", async () => {
  const { coordinator, edit } = setup(1);
  const waiting = coordinator.waitForAssetReload("hero", 1000);
  const tx = await edit(1);
  assert.strictEqual(await waiting, tx);
});

test("maxTransactionHistory must be a positive integer", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => setup(bad), RangeError, String(bad));
  }
});
