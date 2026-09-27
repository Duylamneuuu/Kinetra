import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AssetDatabase,
  AssetReimportService,
  SourceAssetWatcher,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  type AssetRecord,
  type ReimportEvent,
  type SourceChangeEvent,
} from "../src/index.js";

function makeRecord(id: string, sourcePath: string, importedPath: string, dependencies: string[] = []): AssetRecord {
  const sourceHash = hashBytes(new TextEncoder().encode(`source_init_${id}`));
  const recipe = { importer: "glb", importerVersion: "1.0", settings: { optimize: true } };
  return {
    id,
    kind: "model",
    source: {
      path: sourcePath,
      kind: "source",
      contentHash: sourceHash,
    },
    importedPath,
    recipe,
    fingerprint: importFingerprint({
      sourceHash,
      importer: recipe.importer,
      importerVersion: recipe.importerVersion,
      settings: recipe.settings,
    }),
    dependencies,
    diagnostics: [],
    metadata: { polycount: 100 },
  };
}

test("P4: Dependency Invalidation Set A <- B <- C, D unrelated", () => {
  const db = new AssetDatabase();
  // A has no dependencies
  // B depends on A
  // C depends on B
  // D is unrelated
  db.upsert(makeRecord("asset_A", "source_a.glb", "imported_a.glb", []));
  db.upsert(makeRecord("asset_B", "source_b.glb", "imported_b.glb", ["asset_A"]));
  db.upsert(makeRecord("asset_C", "source_c.glb", "imported_c.glb", ["asset_B"]));
  db.upsert(makeRecord("asset_D", "source_d.glb", "imported_d.glb", []));

  // Changing A invalidates A, B, C (stable sorted ordering)
  const setA = db.invalidationSet("asset_A");
  assert.deepEqual(setA, ["asset_A", "asset_B", "asset_C"]);

  // Changing B invalidates B, C (stable sorted ordering)
  const setB = db.invalidationSet("asset_B");
  assert.deepEqual(setB, ["asset_B", "asset_C"]);

  // Changing C invalidates C
  const setC = db.invalidationSet("asset_C");
  assert.deepEqual(setC, ["asset_C"]);

  // Changing D invalidates D only
  const setD = db.invalidationSet("asset_D");
  assert.deepEqual(setD, ["asset_D"]);
});

test("P4: SourceAssetWatcher handles debounce, touches, atomic writes, and content change detection", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-watcher-test-"));

  try {
    const fileA = join(tempDir, "source_a.txt");
    const fileB = join(tempDir, "source_b.txt");

    await writeFile(fileA, "content_v1", "utf8");
    await writeFile(fileB, "content_b_init", "utf8");

    const events: SourceChangeEvent[] = [];
    const watcher = new SourceAssetWatcher({
      debounceMs: 50,
      onEvent: (e) => events.push(e),
    });

    watcher.addAsset("asset_A", fileA);
    watcher.addAsset("asset_B", fileB);

    await watcher.start();
    assert.equal(watcher.isWatching(), true);

    // 1. Single write -> exactly one change event
    events.length = 0;
    await writeFile(fileA, "content_v2", "utf8");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.assetId, "asset_A");
    assert.equal(events[0]?.newContentHash, hashBytes(new TextEncoder().encode("content_v2")));

    // 2. Multiple rapid writes with same final content -> coalesced into exactly one event
    events.length = 0;
    await writeFile(fileA, "content_v3_rapid_1", "utf8");
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(fileA, "content_v3_rapid_2", "utf8");
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(fileA, "content_v3", "utf8");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.assetId, "asset_A");
    assert.equal(events[0]?.newContentHash, hashBytes(new TextEncoder().encode("content_v3")));

    // 3. Touch without content change -> zero change events
    events.length = 0;
    const now = new Date();
    await utimes(fileA, now, now);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.length, 0, "Touch with identical content must not emit change event");

    // 4. Atomic replace (write temp -> rename) -> exactly one event
    events.length = 0;
    const tmpFile = join(tempDir, "source_a.tmp");
    await writeFile(tmpFile, "content_v4_atomic", "utf8");
    await new Promise((r) => setTimeout(r, 10));
    const { rename } = await import("node:fs/promises");
    await rename(tmpFile, fileA);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.assetId, "asset_A");
    assert.equal(events[0]?.newContentHash, hashBytes(new TextEncoder().encode("content_v4_atomic")));

    // 5. Two different assets change -> distinct events
    events.length = 0;
    await writeFile(fileA, "content_v5", "utf8");
    await writeFile(fileB, "content_b_v2", "utf8");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.length, 2);
    const assetIds = events.map((e) => e.assetId).sort();
    assert.deepEqual(assetIds, ["asset_A", "asset_B"]);

    await watcher.stop();
    assert.equal(watcher.isWatching(), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("P4: AssetReimportService handles NOOP, atomic replacement, failure rollback, and recovery", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "kinetra-reimport-test-"));

  try {
    const sourcePath = join(tempDir, "crate.glb");
    const importedPath = join(tempDir, "imported_crate.glb");

    // Create valid GLB v1
    const glbV1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: "CrateV1" });
    await writeFile(sourcePath, glbV1);
    await writeFile(importedPath, glbV1);

    const db = new AssetDatabase();
    const sourceHashV1 = hashBytes(glbV1);
    const recipe = { importer: "glb", importerVersion: "1.0", settings: { optimize: true } };
    const fingerprintV1 = importFingerprint({
      sourceHash: sourceHashV1,
      importer: recipe.importer,
      importerVersion: recipe.importerVersion,
      settings: recipe.settings,
    });

    const record: AssetRecord = {
      id: "prop_crate",
      kind: "model",
      source: {
        path: sourcePath,
        kind: "source",
        contentHash: sourceHashV1,
      },
      importedPath,
      recipe,
      fingerprint: fingerprintV1,
      dependencies: [],
      diagnostics: [],
      metadata: { dimensions: [1, 1, 1] },
    };
    db.upsert(record);

    const events: ReimportEvent[] = [];
    const reimportService = new AssetReimportService({
      database: db,
      onEvent: (e) => events.push(e),
    });

    // 1. Initial check: NOOP because source content matches record fingerprint
    events.length = 0;
    const noopResult = await reimportService.reimport("prop_crate");
    assert.equal(noopResult.status, "noop");
    assert.equal(noopResult.fingerprint, fingerprintV1);
    assert.equal(events.some((e) => e.type === "asset.reimportNoop"), true);

    // 2. Modify source to valid GLB v2 (size: [1.8, 1.8, 1.8])
    events.length = 0;
    const glbV2 = await createSyntheticGlb({ size: [1.8, 1.8, 1.8], meshName: "CrateV2" });
    await writeFile(sourcePath, glbV2);

    const v2Result = await reimportService.reimport("prop_crate");
    assert.equal(v2Result.status, "reimported");
    assert.notEqual(v2Result.newFingerprint, fingerprintV1);
    assert.equal(v2Result.oldFingerprint, fingerprintV1);

    const updatedRecordV2 = db.get("prop_crate")!;
    assert.equal(updatedRecordV2.fingerprint, v2Result.newFingerprint);
    assert.equal(updatedRecordV2.source.contentHash, hashBytes(glbV2));

    // Verify imported file was atomically updated on disk
    const { readFile: readDiskFile } = await import("node:fs/promises");
    const diskBytesV2 = await readDiskFile(importedPath);
    assert.equal(hashBytes(diskBytesV2), hashBytes(glbV2));
    assert.equal(events.some((e) => e.type === "asset.reimportSucceeded"), true);

    // 3. FAILURE ROLLBACK: Corrupt source file written
    events.length = 0;
    const corruptBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]); // Invalid GLB
    await writeFile(sourcePath, corruptBytes);

    const failResult = await reimportService.reimport("prop_crate");
    assert.equal(failResult.status, "failed");
    assert.ok(failResult.error?.includes("GLB") || failResult.error?.includes("magic") || failResult.error?.includes("smaller"));
    assert.equal(events.some((e) => e.type === "asset.reimportFailed"), true);

    // CRITICAL INVARIANT: The database and imported artifact on disk MUST remain at v2!
    const recordAfterFailure = db.get("prop_crate")!;
    assert.equal(recordAfterFailure.fingerprint, updatedRecordV2.fingerprint, "AssetRecord must remain at v2");
    assert.equal(recordAfterFailure.source.contentHash, hashBytes(glbV2), "AssetRecord source hash must remain at v2");

    const diskBytesAfterFailure = await readDiskFile(importedPath);
    assert.equal(hashBytes(diskBytesAfterFailure), hashBytes(glbV2), "Imported artifact must remain at valid v2");

    // 4. RECOVERY: Repair source to valid GLB v3
    events.length = 0;
    const glbV3 = await createSyntheticGlb({ size: [2.5, 2.5, 2.5], meshName: "CrateV3" });
    await writeFile(sourcePath, glbV3);

    const v3Result = await reimportService.reimport("prop_crate");
    assert.equal(v3Result.status, "reimported");
    assert.notEqual(v3Result.newFingerprint, updatedRecordV2.fingerprint);

    const recordAfterRecovery = db.get("prop_crate")!;
    assert.equal(recordAfterRecovery.fingerprint, v3Result.newFingerprint);
    assert.equal(recordAfterRecovery.source.contentHash, hashBytes(glbV3));

    const diskBytesV3 = await readDiskFile(importedPath);
    assert.equal(hashBytes(diskBytesV3), hashBytes(glbV3));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
