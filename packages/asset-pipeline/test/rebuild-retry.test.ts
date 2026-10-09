import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type AssetImporterContext,
  type AssetRecord,
} from "../src/index.js";

class FlakyImporter implements AssetImporter {
  failing = false;
  readonly #inner = new GlbDirectImporter();
  import(context: AssetImporterContext) {
    if (this.failing) return Promise.reject(new Error("transient importer failure"));
    return this.#inner.import(context);
  }
}

function record(
  id: string,
  sourcePath: string,
  importedPath: string,
  sourceBytes: Uint8Array,
  importer: string,
  dependencies: AssetRecord["dependencies"],
  dependencyFingerprints: string[],
): AssetRecord {
  const recipe = { importer, importerVersion: "1.0", settings: {} };
  const sourceHash = hashBytes(sourceBytes);
  return {
    id,
    kind: "model",
    source: { path: sourcePath, kind: "source", contentHash: sourceHash },
    importedPath,
    recipe,
    fingerprint: importFingerprint({
      sourceHash,
      importer,
      importerVersion: "1.0",
      settings: {},
      dependencyFingerprints,
    }),
    dependencies,
    diagnostics: [],
    metadata: {},
  };
}

test("reimportWithDependents retries a dependent that failed on an earlier run even though the root is now a noop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-rebuild-retry-"));
  try {
    const aSource = join(dir, "a.glb");
    const bSource = join(dir, "b.glb");
    const aOut = join(dir, "a.out.glb");
    const bOut = join(dir, "b.out.glb");
    const aV1 = await createSyntheticGlb({ size: [1, 1, 1], meshName: "A1" });
    const aV2 = await createSyntheticGlb({ size: [2, 2, 2], meshName: "A2" });
    const bBytes = await createSyntheticGlb({ size: [1, 1, 1], meshName: "B" });
    await writeFile(aSource, aV1);
    await writeFile(aOut, aV1);
    await writeFile(bSource, bBytes);
    await writeFile(bOut, bBytes);

    const recordA = record("asset_A", aSource, aOut, aV1, "glb", [], []);
    const recordB = record("asset_B", bSource, bOut, bBytes, "flaky", ["asset_A"], [recordA.fingerprint]);
    const db = new AssetDatabase();
    db.upsert(recordA);
    db.upsert(recordB);

    const flaky = new FlakyImporter();
    const service = new AssetReimportService({ database: db, importers: new Map([["flaky", flaky]]) });

    // A changes, B's importer fails: B is left stale on its old fingerprint.
    await writeFile(aSource, aV2);
    flaky.failing = true;
    const first = await service.reimportWithDependents("asset_A");
    assert.equal(first.status, "partial_failure");
    assert.equal(first.failedAssetId, "asset_B");
    assert.equal(db.get("asset_B")!.fingerprint, recordB.fingerprint, "B stays on its old fingerprint");

    // The importer recovers. A's source did not change again, so A itself is a noop, but B is
    // still stale and the retry must rebuild it instead of reporting "noop" and leaving it stale.
    flaky.failing = false;
    const second = await service.reimportWithDependents("asset_A");
    assert.equal(second.status, "reimported");
    assert.deepEqual(second.rebuiltAssetIds, ["asset_B"]);
    assert.deepEqual(second.blockedAssetIds, []);

    const newA = db.get("asset_A")!;
    const expectedB = importFingerprint({
      sourceHash: hashBytes(bBytes),
      importer: "flaky",
      importerVersion: "1.0",
      settings: {},
      dependencyFingerprints: [newA.fingerprint],
    });
    assert.equal(db.get("asset_B")!.fingerprint, expectedB);

    // Everything is current now: a third run is a genuine noop.
    const third = await service.reimportWithDependents("asset_A");
    assert.equal(third.status, "noop");
    assert.deepEqual(third.rebuiltAssetIds, []);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
