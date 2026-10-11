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

async function fixture(): Promise<{ dir: string; bytes: Uint8Array; paths: (name: string) => [string, string] }> {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-dep-missing-"));
  const bytes = await createSyntheticGlb({ size: [1, 1, 1], meshName: "A" });
  const paths = (name: string): [string, string] => [join(dir, `${name}.glb`), join(dir, `${name}.out.glb`)];
  for (const name of ["a", "b"]) for (const path of paths(name)) await writeFile(path, bytes);
  return { dir, bytes, paths };
}

test("reimport of an up-to-date asset still reports a dependency that is not in the database", async () => {
  const { dir, bytes, paths } = await fixture();
  try {
    const [aSource, aOut] = paths("a");
    const [bSource, bOut] = paths("b");
    const recordA = record("asset_A", aSource, aOut, bytes, [], []);
    const recordB = record("asset_B", bSource, bOut, bytes, ["asset_A", "asset_ghost"], [recordA.fingerprint]);
    const db = new AssetDatabase();
    db.upsert(recordA);
    db.upsert(recordB);
    const service = new AssetReimportService({ database: db });

    const result = await service.reimport("asset_B");

    assert.equal(result.status, "noop");
    assert.equal(result.diagnostics?.length, 1);
    const [diagnostic] = result.diagnostics ?? [];
    assert.equal(diagnostic?.code, "asset.dependency.missing");
    assert.equal(diagnostic?.severity, "warning");
    assert.match(diagnostic?.message ?? "", /asset_ghost/);
    assert.equal(diagnostic?.path, bSource);
    // A noop leaves the stored record alone.
    assert.deepEqual(db.get("asset_B")?.diagnostics, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reimport that rebuilds an asset stores the missing-dependency warning next to the importer diagnostics", async () => {
  const { dir, bytes, paths } = await fixture();
  try {
    const [aSource, aOut] = paths("a");
    const [bSource, bOut] = paths("b");
    const recordA = record("asset_A", aSource, aOut, bytes, [], []);
    const recordB = record("asset_B", bSource, bOut, bytes, ["asset_A", "asset_ghost", "asset_ghost_two"], [recordA.fingerprint]);
    const db = new AssetDatabase();
    db.upsert(recordA);
    db.upsert(recordB);
    const service = new AssetReimportService({ database: db });

    // Change B's source so reimport() has to rebuild it.
    const changed = await createSyntheticGlb({ size: [2, 2, 2], meshName: "B" });
    await writeFile(bSource, changed);
    const result = await service.reimport("asset_B");

    assert.equal(result.status, "reimported");
    const codes = (result.diagnostics ?? []).map((d) => d.code);
    assert.deepEqual(codes.filter((c) => c === "asset.dependency.missing").length, 2);
    assert.deepEqual(db.get("asset_B")?.diagnostics, result.diagnostics);
    const messages = (db.get("asset_B")?.diagnostics ?? []).map((d) => d.message).join("\n");
    assert.match(messages, /asset_ghost"/);
    assert.match(messages, /asset_ghost_two/);

    // The warning is not sticky: once the dependency list is fixed and the asset rebuilt, it is gone.
    const fixed = { ...(db.get("asset_B") as AssetRecord), dependencies: ["asset_A"] };
    db.upsert(fixed);
    await writeFile(bSource, await createSyntheticGlb({ size: [3, 3, 3], meshName: "B3" }));
    const again = await service.reimport("asset_B");
    assert.equal(again.status, "reimported");
    assert.equal((db.get("asset_B")?.diagnostics ?? []).some((d) => d.code === "asset.dependency.missing"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reimport reports nothing when every declared dependency exists", async () => {
  const { dir, bytes, paths } = await fixture();
  try {
    const [aSource, aOut] = paths("a");
    const [bSource, bOut] = paths("b");
    const recordA = record("asset_A", aSource, aOut, bytes, [], []);
    const recordB = record("asset_B", bSource, bOut, bytes, ["asset_A"], [recordA.fingerprint]);
    const db = new AssetDatabase();
    db.upsert(recordA);
    db.upsert(recordB);
    const service = new AssetReimportService({ database: db });

    const result = await service.reimport("asset_B");

    assert.equal(result.status, "noop");
    assert.equal(result.diagnostics, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
