import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AssetDatabase,
  AssetHotReloadCoordinator,
  AssetReimportService,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  SourceAssetWatcher,
  type AssetHotReloadTransaction,
  type ReimportEvent,
  type RuntimeReloadResult,
  type RuntimeReloadTarget,
} from "../src/index.js";

/** One model asset on disk, a coordinator wired to a scripted runtime, and a way to trigger a reload. */
async function setup(reloadResult: () => unknown) {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-coordinator-degraded-"));
  const sourcePath = join(dir, "hero.glb");
  const artifactPath = join(dir, "imported_hero.glb");
  const v1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: "HeroMesh" });
  await writeFile(sourcePath, v1);
  await writeFile(artifactPath, v1);
  const hash = hashBytes(v1);
  const database = new AssetDatabase();
  database.upsert({
    id: "asset_hero",
    kind: "model",
    source: { path: sourcePath, kind: "source", contentHash: hash },
    importedPath: artifactPath,
    recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
    fingerprint: importFingerprint({ sourceHash: hash, importer: "glb", importerVersion: "1.0", settings: {} }),
    dependencies: [],
    diagnostics: [],
    metadata: {},
  });
  const runtimeTarget: RuntimeReloadTarget = {
    async updateAsset() {},
    async reloadAsset() {
      return reloadResult() as RuntimeReloadResult;
    },
  };
  const events: ReimportEvent[] = [];
  const coordinator = new AssetHotReloadCoordinator({
    database,
    reimportService: new AssetReimportService({ database }),
    watcher: new SourceAssetWatcher({ debounceMs: 10 }),
    runtimeTarget,
    onEvent: (event) => events.push(event),
  });
  const reload = async (): Promise<AssetHotReloadTransaction> => {
    await writeFile(sourcePath, await createSyntheticGlb({ size: [4, 2, 1], meshName: "HeroMesh" }));
    const tx = await coordinator.processAssetChange("asset_hero");
    assert.ok(tx, "no transaction for a changed source");
    return tx;
  };
  return { events, reload, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const degraded = (events: ReimportEvent[]) => events.filter((e) => e.type === "asset.runtimeReloadDegraded");

test("root motion dropped by the reload is a warning event and lands on the transaction", async () => {
  const { events, reload, cleanup } = await setup(() => ({
    success: true,
    affectedEntities: ["hero"],
    droppedRootMotion: { hero: "root bone \"Hips\" no longer exists" },
  }));
  try {
    const tx = await reload();
    assert.deepEqual(tx.droppedRootMotion, { hero: 'root bone "Hips" no longer exists' });
    assert.equal(tx.droppedIkChains, undefined);
    assert.equal(tx.droppedMorphOverrides, undefined);
    assert.deepEqual(tx.runtimeReloadedEntityIds, ["hero"], "the reload itself still succeeded");

    const events1 = degraded(events);
    assert.equal(events1.length, 1);
    const [event] = events1;
    assert.equal(event?.assetId, "asset_hero");
    assert.deepEqual(event?.droppedRootMotion, { hero: 'root bone "Hips" no longer exists' });
    assert.equal(event?.diagnostics?.length, 1);
    const diagnostic = event?.diagnostics?.[0];
    assert.equal(diagnostic?.severity, "warning");
    assert.equal(diagnostic?.code, "asset.reload.rootMotionDropped");
    assert.equal(diagnostic?.path, "hero");
    assert.match(diagnostic?.message ?? "", /hero/);
    assert.match(diagnostic?.message ?? "", /Hips/);
    assert.ok(
      events.some((e) => e.type === "asset.runtimeReloadSucceeded"),
      "success is still reported alongside the warning",
    );
  } finally {
    await cleanup();
  }
});

test("IK chains and morph overrides are forwarded too, one diagnostic per entity and kind", async () => {
  const { events, reload, cleanup } = await setup(() => ({
    success: true,
    affectedEntities: ["hero", "npc"],
    droppedIkChains: { hero: ["leftArm", "rightArm"] },
    droppedMorphOverrides: { npc: ["smile"] },
  }));
  try {
    const tx = await reload();
    assert.deepEqual(tx.droppedIkChains, { hero: ["leftArm", "rightArm"] });
    assert.deepEqual(tx.droppedMorphOverrides, { npc: ["smile"] });
    assert.equal(tx.droppedRootMotion, undefined);
    const [event] = degraded(events);
    assert.deepEqual(
      event?.diagnostics?.map((d) => `${d.code}:${d.path}`),
      ["asset.reload.ikChainsDropped:hero", "asset.reload.morphOverridesDropped:npc"],
    );
    assert.match(event?.diagnostics?.[0]?.message ?? "", /leftArm, rightArm/);
  } finally {
    await cleanup();
  }
});

test("a clean reload emits no degraded event and the transaction carries no dropped fields", async () => {
  const { events, reload, cleanup } = await setup(() => ({ success: true, affectedEntities: ["hero"] }));
  try {
    const tx = await reload();
    assert.equal(degraded(events).length, 0);
    assert.ok(!("droppedRootMotion" in tx));
    assert.ok(!("droppedIkChains" in tx));
    assert.ok(!("droppedMorphOverrides" in tx));
  } finally {
    await cleanup();
  }
});

test("empty dropped maps count as clean", async () => {
  const { events, reload, cleanup } = await setup(() => ({
    success: true,
    affectedEntities: ["hero"],
    droppedRootMotion: {},
    droppedIkChains: {},
    droppedMorphOverrides: {},
  }));
  try {
    const tx = await reload();
    assert.equal(degraded(events).length, 0);
    assert.ok(!("droppedRootMotion" in tx));
  } finally {
    await cleanup();
  }
});

test("a failed reload reports failure only, never a degraded warning", async () => {
  const { events, reload, cleanup } = await setup(() => ({
    success: false,
    affectedEntities: [],
    error: "decode failed",
    droppedRootMotion: { hero: "stale" },
  }));
  try {
    const tx = await reload();
    assert.equal(degraded(events).length, 0);
    assert.ok(events.some((e) => e.type === "asset.runtimeReloadFailed"));
    assert.ok(!("droppedRootMotion" in tx));
  } finally {
    await cleanup();
  }
});

test("entity ids that look like prototype keys survive as own keys", async () => {
  const dropped = JSON.parse('{"__proto__": "root bone gone", "constructor": "also gone"}') as Record<string, string>;
  const { events, reload, cleanup } = await setup(() => ({
    success: true,
    affectedEntities: ["x"],
    droppedRootMotion: dropped,
  }));
  try {
    const tx = await reload();
    const record = tx.droppedRootMotion ?? {};
    assert.deepEqual(Object.keys(record).sort(), ["__proto__", "constructor"]);
    assert.equal(Object.getOwnPropertyDescriptor(record, "__proto__")?.value, "root bone gone");
    assert.equal(Object.getPrototypeOf(record), Object.prototype, "the record's own prototype was not replaced");
    assert.equal(degraded(events)[0]?.diagnostics?.length, 2);
  } finally {
    await cleanup();
  }
});

test("a malformed report from the runtime is ignored per entry and never throws", async () => {
  const { events, reload, cleanup } = await setup(() => ({
    success: true,
    affectedEntities: ["hero"],
    droppedRootMotion: { hero: "root gone", broken: 42, empty: "" },
    droppedIkChains: { hero: "not-an-array", ok: ["arm", 7, null] },
    droppedMorphOverrides: ["nope"],
  }));
  try {
    const tx = await reload();
    assert.deepEqual(tx.droppedRootMotion, { hero: "root gone" });
    assert.deepEqual(tx.droppedIkChains, { ok: ["arm"] });
    assert.equal(tx.droppedMorphOverrides, undefined);
    assert.equal(degraded(events).length, 1);
  } finally {
    await cleanup();
  }
});

test("a report that is entirely garbage is treated as a clean reload", async () => {
  const { events, reload, cleanup } = await setup(() => ({
    success: true,
    affectedEntities: ["hero"],
    droppedRootMotion: "gone",
    droppedIkChains: null,
    droppedMorphOverrides: 5,
  }));
  try {
    const tx = await reload();
    assert.equal(degraded(events).length, 0);
    assert.deepEqual(tx.runtimeReloadedEntityIds, ["hero"]);
  } finally {
    await cleanup();
  }
});
