import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetDatabase,
  AssetHotReloadCoordinator,
  AssetReimportService,
  hashBytes,
  importFingerprint,
  type AssetImporter,
  type AssetRecord,
  type FileSystemAdapter,
  type ReimportEvent,
  type RuntimeReloadTarget,
  type SourceAssetWatcher,
  type SourceChangeEvent,
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

function stubWatcher() {
  const listeners = new Set<(event: SourceChangeEvent) => void>();
  const calls = { start: 0, stop: 0 };
  const watcher = {
    onEvent(listener: (event: SourceChangeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      calls.start++;
    },
    async stop() {
      calls.stop++;
    },
  } as unknown as SourceAssetWatcher;
  return {
    watcher,
    listeners,
    calls,
    emit(assetId: string) {
      for (const listener of [...listeners]) {
        listener({ type: "asset.changeDetected", assetId, sourcePath: `src/${assetId}.txt`, newContentHash: "x" });
      }
    },
  };
}

function record(id: string, dependencies: string[] = []): AssetRecord {
  const recipe = { importer: "raw", importerVersion: "1", settings: {} };
  const sourceHash = hashBytes(enc(`${id}-initial`));
  return {
    id,
    kind: "other",
    source: { path: `src/${id}.txt`, kind: "source", contentHash: sourceHash },
    importedPath: `out/${id}.bin`,
    recipe,
    fingerprint: importFingerprint({ sourceHash, ...recipe }),
    dependencies,
    diagnostics: [],
    metadata: {},
  };
}

interface Harness {
  files: Map<string, Uint8Array>;
  database: AssetDatabase;
  coordinator: AssetHotReloadCoordinator;
  watcher: ReturnType<typeof stubWatcher>;
  events: ReimportEvent[];
}

function harness(options: {
  runtimeTarget?: unknown;
  records?: AssetRecord[];
  coordinatorFs?: FileSystemAdapter;
} = {}): Harness {
  const records = options.records ?? [record("hero")];
  const files = new Map<string, Uint8Array>();
  for (const r of records) files.set(r.source.path, enc(`${r.id}-v1`));
  const fs = memoryFs(files);
  const database = new AssetDatabase();
  for (const r of records) database.upsert(r);
  const reimportService = new AssetReimportService({
    database,
    importers: new Map([["raw", rawImporter]]),
    fileSystem: fs,
  });
  const watcher = stubWatcher();
  const events: ReimportEvent[] = [];
  const coordinator = new AssetHotReloadCoordinator({
    database,
    reimportService,
    watcher: watcher.watcher,
    fileSystem: options.coordinatorFs ?? fs,
    ...(options.runtimeTarget ? { runtimeTarget: options.runtimeTarget as RuntimeReloadTarget } : {}),
    onEvent: (event) => events.push(event),
  });
  return { files, database, coordinator, watcher, events };
}

function quietConsole<T>(body: () => Promise<T>): Promise<{ result: T; errors: unknown[][] }> {
  const original = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  return body()
    .then((result) => ({ result, errors }))
    .finally(() => {
      console.error = original;
    });
}

test("an unknown asset produces no transaction and no history entry", async () => {
  const { coordinator } = harness();
  assert.equal(await coordinator.processAssetChange("ghost"), null);
  assert.deepEqual(coordinator.getTransactionHistory(), []);
});

test("an unchanged source is a noop: no transaction, no runtime traffic", async () => {
  const calls: string[] = [];
  const runtimeTarget: RuntimeReloadTarget = {
    async updateAsset(id) {
      calls.push(`update ${id}`);
    },
    async reloadAsset(id) {
      calls.push(`reload ${id}`);
      return { success: true, affectedEntities: [] };
    },
  };
  const { coordinator } = harness({ runtimeTarget });
  assert.ok(await coordinator.processAssetChange("hero"), "first run rebuilds (initial hash differs from the file)");
  calls.length = 0;
  assert.equal(await coordinator.processAssetChange("hero"), null);
  assert.deepEqual(calls, []);
  assert.equal(coordinator.getTransactionHistory().length, 1);
});

test("a transaction without a runtime target describes the rebuild and notifies listeners", async () => {
  const { coordinator, files } = harness({ records: [record("base"), record("leaf", ["base"]), record("other")] });
  const seen: string[] = [];
  const off = coordinator.onTransaction((tx) => seen.push(tx.rootAssetId));

  const tx = await coordinator.processAssetChange("base");
  assert.ok(tx);
  assert.equal(tx.rootAssetId, "base");
  assert.equal(tx.importer, "raw");
  assert.equal(tx.newSourceHash, hashBytes(enc("base-v1")));
  assert.equal(tx.oldSourceHash, hashBytes(enc("base-initial")));
  assert.deepEqual(tx.rebuildOrder, ["base", "leaf"]);
  assert.deepEqual(tx.rebuiltAssetIds, ["base", "leaf"]);
  assert.deepEqual(tx.blockedAssetIds, []);
  assert.deepEqual(tx.unaffectedAssetIds, ["other"]);
  assert.deepEqual(tx.runtimeReloadedEntityIds, []);
  assert.deepEqual(tx.runtimeUnchangedEntityIds, []);
  assert.notEqual(tx.oldFingerprint, tx.newFingerprint);
  assert.deepEqual(files.get("out/leaf.bin"), enc("leaf-v1"));
  assert.deepEqual(seen, ["base"]);
  assert.strictEqual(coordinator.getTransactionHistory()[0], tx);

  off();
  files.set("src/base.txt", enc("base-v2"));
  await coordinator.processAssetChange("base");
  assert.deepEqual(seen, ["base"], "unsubscribed listener is not called again");
  assert.equal(coordinator.getTransactionHistory().length, 2);
});

test("a throwing transaction listener is logged and does not lose the transaction", async () => {
  const { coordinator } = harness();
  const later: string[] = [];
  coordinator.onTransaction(() => {
    throw new Error("listener bug");
  });
  coordinator.onTransaction((tx) => later.push(tx.rootAssetId));
  const { result, errors } = await quietConsole(() => coordinator.processAssetChange("hero"));
  assert.ok(result);
  assert.deepEqual(later, ["hero"]);
  assert.equal(coordinator.getTransactionHistory().length, 1);
  assert.equal(errors.length, 1);
});

test("a failed root reimport still records a transaction with the error and never touches the runtime", async () => {
  const calls: string[] = [];
  const runtimeTarget: RuntimeReloadTarget = {
    async updateAsset() {
      calls.push("update");
    },
    async reloadAsset() {
      calls.push("reload");
      return { success: true, affectedEntities: [] };
    },
  };
  const { coordinator, files, database } = harness({ runtimeTarget, records: [record("base"), record("leaf", ["base"])] });
  files.delete("src/base.txt");
  const tx = await coordinator.processAssetChange("base");
  assert.ok(tx);
  assert.match(tx.error ?? "", /Failed to read source file/);
  assert.equal(tx.newSourceHash, "");
  assert.equal(tx.failedAssetId, "base");
  assert.deepEqual(tx.rebuiltAssetIds, []);
  assert.deepEqual(tx.blockedAssetIds, ["leaf"]);
  assert.equal(tx.newFingerprint, database.get("base")?.fingerprint, "falls back to the stored fingerprint");
  assert.deepEqual(calls, []);
});

test("runtime publishing passes the artifact bytes (base64) with fingerprint and source hash, then reloads", async () => {
  const updates: Array<{ id: string; data: string; options: unknown }> = [];
  const runtimeTarget: RuntimeReloadTarget = {
    async updateAsset(id, data, options) {
      updates.push({ id, data, options });
    },
    async reloadAsset() {
      return { success: true, affectedEntities: ["e1"] };
    },
  };
  const { coordinator, database } = harness({ runtimeTarget });
  const tx = await coordinator.processAssetChange("hero");
  assert.ok(tx);
  const stored = database.get("hero");
  assert.deepEqual(updates, [
    {
      id: "hero",
      data: Buffer.from(enc("hero-v1")).toString("base64"),
      options: { fingerprint: stored?.fingerprint, sourceHash: stored?.source.contentHash },
    },
  ]);
  assert.deepEqual(tx.runtimeReloadedEntityIds, ["e1"]);
});

test("entities not reloaded are reported as unchanged, whichever query surface the runtime offers", async () => {
  const reload = async () => ({ success: true, affectedEntities: ["a"] });
  const update = async () => undefined;
  const entities = [{ entityId: "a" }, { entityId: "b" }, { entityId: "c" }];
  const surfaces: Array<[string, unknown]> = [
    ["queryEntities", { updateAsset: update, reloadAsset: reload, queryEntities: async () => entities }],
    ["queryState", { updateAsset: update, reloadAsset: reload, queryState: async () => ({ entities }) }],
    ["snapshot.state", { updateAsset: update, reloadAsset: reload, snapshot: async () => ({ state: { entities } }) }],
    ["snapshot.entities", { updateAsset: update, reloadAsset: reload, snapshot: async () => ({ entities }) }],
    ["host.query", { updateAsset: update, reloadAsset: reload, host: { query: async () => ({ entities }) } }],
  ];
  for (const [name, runtimeTarget] of surfaces) {
    const { coordinator } = harness({ runtimeTarget });
    const tx = await coordinator.processAssetChange("hero");
    assert.ok(tx, name);
    assert.deepEqual(tx.runtimeReloadedEntityIds, ["a"], name);
    assert.deepEqual(tx.runtimeUnchangedEntityIds, ["b", "c"], name);
  }
});

test("a query surface that throws or returns junk leaves the unchanged list empty instead of failing the transaction", async () => {
  const base = { updateAsset: async () => undefined, reloadAsset: async () => ({ success: true, affectedEntities: [] }) };
  const targets: Array<[string, unknown]> = [
    ["queryEntities throws", { ...base, queryEntities: async () => { throw new Error("gone"); } }],
    ["queryState without entities", { ...base, queryState: async () => ({}) }],
    ["queryState null", { ...base, queryState: async () => null }],
    ["snapshot without entities", { ...base, snapshot: async () => ({ state: {} }) }],
    ["snapshot throws", { ...base, snapshot: async () => { throw new Error("gone"); } }],
    ["host.query non-array", { ...base, host: { query: async () => ({ entities: "nope" }) } }],
    ["host.query throws", { ...base, host: { query: async () => { throw new Error("gone"); } } }],
  ];
  for (const [name, runtimeTarget] of targets) {
    const { coordinator } = harness({ runtimeTarget });
    const tx = await coordinator.processAssetChange("hero");
    assert.ok(tx, name);
    assert.deepEqual(tx.runtimeUnchangedEntityIds, [], name);
    assert.deepEqual(tx.runtimeReloadedEntityIds, [], name);
  }
});

test("a reload that reports failure or throws emits asset.runtimeReloadFailed and the transaction still completes", async () => {
  const cases: Array<[string, RuntimeReloadTarget, RegExp]> = [
    [
      "reports failure",
      { updateAsset: async () => undefined, reloadAsset: async () => ({ success: false, affectedEntities: [], error: "mesh missing" }) },
      /mesh missing/,
    ],
    [
      "throws an Error",
      { updateAsset: async () => undefined, reloadAsset: async () => { throw new Error("context lost"); } },
      /context lost/,
    ],
    [
      "throws a string",
      // eslint-disable-next-line no-throw-literal
      { updateAsset: async () => undefined, reloadAsset: async () => { throw "plain"; } },
      /plain/,
    ],
  ];
  for (const [name, runtimeTarget, pattern] of cases) {
    const { coordinator, events } = harness({ runtimeTarget });
    const tx = await coordinator.processAssetChange("hero");
    assert.ok(tx, name);
    assert.deepEqual(tx.runtimeReloadedEntityIds, [], name);
    const types = events.filter((e) => e.assetId === "hero" && e.type.startsWith("asset.runtimeReload")).map((e) => e.type);
    assert.deepEqual(types, ["asset.runtimeReloadStarted", "asset.runtimeReloadFailed"], name);
    assert.match(events.find((e) => e.type === "asset.runtimeReloadFailed")?.error ?? "", pattern, name);
  }
});

test("a successful reload emits started then succeeded with the affected entities", async () => {
  const runtimeTarget: RuntimeReloadTarget = {
    updateAsset: async () => undefined,
    reloadAsset: async () => ({ success: true, affectedEntities: ["e1", "e2"] }),
  };
  const { coordinator, events } = harness({ runtimeTarget });
  await coordinator.processAssetChange("hero");
  const runtime = events.filter((e) => e.type.startsWith("asset.runtimeReload"));
  assert.deepEqual(runtime.map((e) => e.type), ["asset.runtimeReloadStarted", "asset.runtimeReloadSucceeded"]);
  assert.deepEqual(runtime[1]?.affectedAssetIds, ["e1", "e2"]);
  assert.equal(runtime[0]?.fingerprint, runtime[1]?.fingerprint);
});

test("an artifact the coordinator cannot read is skipped without calling the runtime", async () => {
  const calls: string[] = [];
  const runtimeTarget: RuntimeReloadTarget = {
    async updateAsset() {
      calls.push("update");
    },
    async reloadAsset() {
      calls.push("reload");
      return { success: true, affectedEntities: [] };
    },
  };
  const unreadable: FileSystemAdapter = { ...memoryFs(new Map()) };
  const { coordinator } = harness({ runtimeTarget, coordinatorFs: unreadable });
  const tx = await coordinator.processAssetChange("hero");
  assert.ok(tx);
  assert.deepEqual(tx.rebuiltAssetIds, ["hero"]);
  assert.deepEqual(calls, []);
});

test("overlapping processAssetChange calls run one transaction at a time, in call order", async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const runtimeTarget: RuntimeReloadTarget = {
    updateAsset: async () => undefined,
    async reloadAsset(assetId) {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start ${assetId}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(`end ${assetId}`);
      active--;
      return { success: true, affectedEntities: [] };
    },
  };
  const { coordinator } = harness({ runtimeTarget, records: [record("a"), record("b"), record("c")] });
  const results = await Promise.all([
    coordinator.processAssetChange("a"),
    coordinator.processAssetChange("b"),
    coordinator.processAssetChange("c"),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.deepEqual(results.map((tx) => tx?.rootAssetId), ["a", "b", "c"]);
  assert.deepEqual(coordinator.getTransactionHistory().map((tx) => tx.rootAssetId), ["a", "b", "c"]);
});

test("waitForAssetReload resolves for the root and for a rebuilt dependent, and ignores unrelated assets", async () => {
  const { coordinator, files } = harness({ records: [record("base"), record("leaf", ["base"]), record("other")] });
  const forLeaf = coordinator.waitForAssetReload("leaf", 2000);
  const forOther = coordinator.waitForAssetReload("other", 50);
  const forRoot = coordinator.waitForAssetReload("base", 2000);
  files.set("src/base.txt", enc("base-v9"));
  await coordinator.processAssetChange("base");
  assert.equal((await forRoot).rootAssetId, "base");
  assert.equal((await forLeaf).rootAssetId, "base", "a dependent resolves with the transaction that rebuilt it");
  await assert.rejects(forOther, /Timeout waiting for asset reload transaction on "other" after 50ms/);
});

test("a timed-out waitForAssetReload unsubscribes and never resolves late", async () => {
  const { coordinator } = harness();
  await assert.rejects(coordinator.waitForAssetReload("hero", 10), /after 10ms/);
  let called = 0;
  coordinator.onTransaction(() => {
    called++;
  });
  await coordinator.processAssetChange("hero");
  assert.equal(called, 1);
});

test("start is idempotent: a second start neither resubscribes nor restarts the watcher", async () => {
  const { coordinator, watcher } = harness();
  await coordinator.start();
  await coordinator.start();
  assert.equal(coordinator.isStarted(), true);
  assert.equal(watcher.calls.start, 1);
  assert.equal(watcher.listeners.size, 1);
  await coordinator.stop();
  assert.equal(coordinator.isStarted(), false);
  assert.equal(watcher.listeners.size, 0);
  assert.equal(watcher.calls.stop, 1);
  await coordinator.stop(); // stopping twice is harmless
  assert.equal(watcher.calls.stop, 2);
});

test("a watcher event is forwarded to listeners and drives a transaction; after stop it does nothing", async () => {
  const { coordinator, watcher, events } = harness();
  await coordinator.start();
  const done = coordinator.waitForAssetReload("hero", 2000);
  watcher.emit("hero");
  const tx = await done;
  assert.equal(tx.rootAssetId, "hero");
  assert.ok(events.some((e) => e.type === "asset.changeDetected" && e.assetId === "hero"));
  assert.ok(events.some((e) => e.type === "asset.reimportSucceeded" && e.assetId === "hero"), "service events are relayed");

  await coordinator.stop();
  const before = coordinator.getTransactionHistory().length;
  watcher.emit("hero");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(coordinator.getTransactionHistory().length, before);
});

test("an error inside a watcher-driven transaction is logged and does not become an unhandled rejection", async () => {
  const database = new AssetDatabase();
  database.upsert(record("hero"));
  const watcher = stubWatcher();
  const reimportService = {
    onEvent: () => () => {},
    reimportWithDependents: async () => {
      throw new Error("service exploded");
    },
  } as unknown as AssetReimportService;
  const coordinator = new AssetHotReloadCoordinator({ database, reimportService, watcher: watcher.watcher });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { errors } = await quietConsole(async () => {
      await coordinator.start();
      watcher.emit("hero");
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), /AssetHotReloadCoordinator error on hero/);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(coordinator.getTransactionHistory(), []);

    // The failed transaction must not wedge the queue: the next call still runs (and fails the same way).
    await assert.rejects(coordinator.processAssetChange("hero"), /service exploded/);
    await assert.rejects(coordinator.processAssetChange("hero"), /service exploded/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await coordinator.stop();
  }
});

test("stop waits for the transaction that is already running", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtimeTarget: RuntimeReloadTarget = {
    updateAsset: async () => undefined,
    async reloadAsset() {
      await gate;
      return { success: true, affectedEntities: [] };
    },
  };
  const { coordinator } = harness({ runtimeTarget });
  await coordinator.start();
  const running = coordinator.processAssetChange("hero");
  await new Promise((resolve) => setTimeout(resolve, 10));

  let stopped = false;
  const stopping = coordinator.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, "stop() returned while a reload was still in flight");

  release();
  await stopping;
  assert.ok(await running);
  assert.equal(stopped, true);
});
