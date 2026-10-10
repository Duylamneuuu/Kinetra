import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AssetDatabase,
  AssetReimportService,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  type AssetRecord,
  type ReimportEvent,
} from "../src/index.js";

function record(
  id: string,
  sourcePath: string,
  importedPath: string,
  bytes: Uint8Array,
  dependencies: string[],
  dependencyFingerprints: string[],
): AssetRecord {
  const sourceHash = hashBytes(bytes);
  return {
    id,
    kind: "model",
    source: { path: sourcePath, kind: "source", contentHash: sourceHash },
    importedPath,
    recipe: { importer: "glb", importerVersion: "1.0", settings: {} },
    fingerprint: importFingerprint({
      sourceHash,
      importer: "glb",
      importerVersion: "1.0",
      settings: {},
      dependencyFingerprints,
    }),
    dependencies,
    diagnostics: [],
    metadata: {},
  };
}

test("reimportWithDependents does not report an up-to-date dependent as stale when it lists a dependency missing from the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-dangling-dep-"));
  try {
    const bytes = await createSyntheticGlb({ size: [1, 1, 1], meshName: "A" });
    const aSource = join(dir, "a.glb");
    const bSource = join(dir, "b.glb");
    const aOut = join(dir, "a.out.glb");
    const bOut = join(dir, "b.out.glb");
    for (const path of [aSource, bSource, aOut, bOut]) await writeFile(path, bytes);

    // B was built by reimport(), which only mixes in the fingerprints of dependencies that exist.
    const recordA = record("asset_A", aSource, aOut, bytes, [], []);
    const recordB = record("asset_B", bSource, bOut, bytes, ["asset_A", "asset_ghost"], [recordA.fingerprint]);
    const db = new AssetDatabase();
    db.upsert(recordA);
    db.upsert(recordB);

    const events: ReimportEvent[] = [];
    const service = new AssetReimportService({ database: db, onEvent: (event) => events.push(event) });

    // Sanity: B is genuinely up to date according to reimport() itself.
    assert.equal((await service.reimport("asset_B")).status, "noop");
    events.length = 0;

    const result = await service.reimportWithDependents("asset_A");

    assert.equal(result.status, "noop");
    assert.deepEqual(result.rebuiltAssetIds, []);
    assert.deepEqual(
      events.filter((event) => event.type === "asset.dependentReimportStarted"),
      [],
      "an up-to-date dependent must not be announced as being rebuilt",
    );
    assert.equal(db.get("asset_B")?.fingerprint, recordB.fingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
