import assert from "node:assert/strict";
import test from "node:test";

import { hashBytes, inspectGlb, normalizeGlb, validateAssetRecord } from "@kinetra/asset-pipeline";

import {
  ORB_RUN_ASSET_IDS,
  ORB_RUN_AUDIO_ASSET,
  ORB_RUN_AUDIO_ASSET_IDS,
  ORB_RUN_MODEL_ASSET,
  ORB_RUN_MODEL_ASSET_IDS,
  buildOrbRunAssets,
  createOrbRunAssetPipeline,
  createOrbRunAssetRecords,
  createOrbRunAssetSources,
  createOrbRunModelBytes,
  importOrbRunAssets,
  orbRunAssetReport,
  orbRunImportedPath,
  orbRunSourcePath,
  validateOrbRunAssets,
} from "../src/index.js";

test("sources: three valid GLB models and one WAV per audio id, deterministic", async () => {
  const first = await createOrbRunAssetSources();
  const second = await createOrbRunAssetSources();
  assert.deepEqual(Object.keys(first).sort(), [...ORB_RUN_ASSET_IDS].sort());
  assert.equal(ORB_RUN_MODEL_ASSET_IDS.length, 3);
  for (const id of ORB_RUN_ASSET_IDS) {
    assert.equal(hashBytes(first[id]!), hashBytes(second[id]!), `${id} bytes are deterministic`);
  }
  for (const id of ORB_RUN_MODEL_ASSET_IDS) {
    assert.equal(inspectGlb(first[id]!).version, 2);
  }
  assert.notEqual(
    hashBytes(first[ORB_RUN_MODEL_ASSET.orb]!),
    hashBytes(first[ORB_RUN_MODEL_ASSET.exitPad]!),
    "different models are different files",
  );
  await assert.rejects(createOrbRunModelBytes("asset_nope"), /Unknown Orb Run model asset/);
});

test("registered records are valid before any import and every audio cue has an asset", async () => {
  const records = createOrbRunAssetRecords(await createOrbRunAssetSources());
  assert.equal(records.length, ORB_RUN_ASSET_IDS.length);
  for (const record of records) {
    assert.deepEqual(
      validateAssetRecord(record).filter((d) => d.severity === "error"),
      [],
      `${record.id} has no validation errors`,
    );
    assert.match(record.source.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(record.source.path, orbRunSourcePath(record.id));
    assert.equal(record.importedPath, orbRunImportedPath(record.id));
  }
  const audioIds = records.filter((r) => r.kind === "audio").map((r) => r.id);
  for (const cue of [
    ...Object.values(ORB_RUN_AUDIO_ASSET).flat(),
  ]) {
    assert.ok(audioIds.includes(cue), `audio cue ${cue} is a registered asset`);
  }
  assert.deepEqual(audioIds, [...ORB_RUN_AUDIO_ASSET_IDS]);
});

test("first import writes every artifact and the whole database validates clean", async () => {
  const built = await buildOrbRunAssets();
  assert.equal(built.results.length, ORB_RUN_ASSET_IDS.length);
  assert.ok(built.results.every((r) => r.status === "reimported"), "every first import is a real import");
  assert.deepEqual(validateOrbRunAssets(built), []);
  assert.equal(built.fileSystem.writeCount, ORB_RUN_ASSET_IDS.length);
  assert.ok(
    [...built.fileSystem.files.keys()].every((path) => !path.includes(".tmp.")),
    "no temp files are left behind",
  );

  const orb = built.database.get(ORB_RUN_MODEL_ASSET.orb)!;
  assert.deepEqual(orb.metadata.dimensions, [0.6, 0.6, 0.6]);
  assert.equal(orb.metadata.polycount, 12);
  assert.equal(orb.metadata.boundsRadius, 0.519615);
  assert.equal(orb.metadata.provenance?.provider, "kinetra-synthetic");

  const pad = built.database.get(ORB_RUN_MODEL_ASSET.exitPad)!;
  assert.deepEqual(pad.metadata.dimensions, [2, 0.1, 2]);

  const win = built.database.get(ORB_RUN_AUDIO_ASSET.win)!;
  assert.equal(win.metadata.sampleRateHz, 22050);
  assert.equal(win.metadata.durationSeconds, 0.6);
  assert.deepEqual(win.diagnostics, [], "sample rate matches the recipe");

  const imported = await normalizeGlb(built.fileSystem.files.get(orb.importedPath)!);
  assert.equal(imported.meshCount, 1);
  assert.equal(imported.nodeCount, 1);
  assert.equal(imported.materialCount, 1);

  const report = orbRunAssetReport(built);
  assert.deepEqual(report.map((row) => row.id), [...ORB_RUN_ASSET_IDS].sort());
  assert.ok(report.every((row) => row.bytes > 44 && /^[a-f0-9]{64}$/.test(row.fingerprint)));
});

test("two independent builds produce byte-identical databases and artifacts", async () => {
  const a = await buildOrbRunAssets();
  const b = await buildOrbRunAssets();
  assert.equal(JSON.stringify(a.database.serialize()), JSON.stringify(b.database.serialize()));
  for (const id of ORB_RUN_ASSET_IDS) {
    const path = orbRunImportedPath(id);
    assert.equal(hashBytes(a.fileSystem.files.get(path)!), hashBytes(b.fileSystem.files.get(path)!), id);
  }
});

test("importing again is a no-op: nothing is rewritten", async () => {
  const built = await buildOrbRunAssets();
  const writesAfterFirst = built.fileSystem.writeCount;
  const fingerprints = orbRunAssetReport(built).map((row) => row.fingerprint);
  const again = await importOrbRunAssets(built);
  assert.ok(again.every((r) => r.status === "noop"));
  assert.equal(built.fileSystem.writeCount, writesAfterFirst);
  assert.deepEqual(orbRunAssetReport(built).map((row) => row.fingerprint), fingerprints);
});

test("an artist edit to one model reimports only that model", async () => {
  const built = await buildOrbRunAssets();
  const before = orbRunAssetReport(built);
  const edited = await createOrbRunModelBytes(ORB_RUN_MODEL_ASSET.orb, { color: [0.9, 0.1, 0.1, 1] });
  built.fileSystem.files.set(orbRunSourcePath(ORB_RUN_MODEL_ASSET.orb), edited);

  const results = await importOrbRunAssets(built);
  const changed = results.filter((r) => r.status !== "noop");
  assert.deepEqual(changed.map((r) => [r.assetId, r.status]), [[ORB_RUN_MODEL_ASSET.orb, "reimported"]]);
  assert.deepEqual(changed[0]!.affectedAssetIds, [ORB_RUN_MODEL_ASSET.orb]);

  const after = orbRunAssetReport(built);
  for (const [index, row] of after.entries()) {
    if (row.id === ORB_RUN_MODEL_ASSET.orb) {
      assert.notEqual(row.fingerprint, before[index]!.fingerprint);
    } else {
      assert.equal(row.fingerprint, before[index]!.fingerprint, `${row.id} untouched`);
    }
  }
  assert.equal(
    built.database.get(ORB_RUN_MODEL_ASSET.orb)!.source.contentHash,
    hashBytes(edited),
    "record tracks the new source hash",
  );
  assert.deepEqual(validateOrbRunAssets(built), []);
  const events = built.events.filter((e) => e.assetId === ORB_RUN_MODEL_ASSET.orb).map((e) => e.type);
  assert.deepEqual(events.slice(-2), ["asset.reimportStarted", "asset.reimportSucceeded"]);
});

test("a corrupt source fails the reimport and keeps the last good artifact", async () => {
  const built = await buildOrbRunAssets();
  const id = ORB_RUN_MODEL_ASSET.player;
  const goodArtifact = built.fileSystem.files.get(orbRunImportedPath(id))!;
  const goodRecord = built.database.get(id)!;

  built.fileSystem.files.set(orbRunSourcePath(id), built.sources[id]!.slice(0, 20));
  const failed = await built.service.reimport(id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /Import or validation failed/);

  assert.equal(
    hashBytes(built.fileSystem.files.get(orbRunImportedPath(id))!),
    hashBytes(goodArtifact),
    "artifact is the last good one",
  );
  assert.deepEqual(built.database.get(id), goodRecord, "record is unchanged");
  assert.ok([...built.fileSystem.files.keys()].every((path) => !path.includes(".tmp.")));

  // Restoring the source heals it.
  built.fileSystem.files.set(orbRunSourcePath(id), built.sources[id]!);
  assert.equal((await built.service.reimport(id)).status, "noop");
});

test("the WAV importer rejects a file that is not a WAV", async () => {
  const built = await buildOrbRunAssets();
  const id = ORB_RUN_AUDIO_ASSET.win;
  built.fileSystem.files.set(orbRunSourcePath(id), built.sources[ORB_RUN_MODEL_ASSET.orb]!);
  const result = await built.service.reimport(id);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /not a RIFF\/WAVE file/);
  assert.equal(built.database.get(id)!.source.contentHash, hashBytes(built.sources[id]!), "record not advanced");
});

test("a WAV at an unexpected sample rate imports with a warning, not silently", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const id = ORB_RUN_AUDIO_ASSET.lose;
  const record = pipeline.database.get(id)!;
  pipeline.database.upsert({ ...record, recipe: { ...record.recipe, settings: { sampleRateHz: 44100 } } });
  const result = await pipeline.service.reimport(id);
  assert.equal(result.status, "reimported");
  assert.deepEqual(result.diagnostics?.map((d) => [d.severity, d.code]), [["warning", "orbrun.audio.sampleRate"]]);
});

test("provenance is policed: synthetic content cannot claim an external AI provider or cost", async () => {
  const records = createOrbRunAssetRecords(await createOrbRunAssetSources());
  const orb = records.find((r) => r.id === ORB_RUN_MODEL_ASSET.orb)!;

  const stolen = validateAssetRecord({
    ...orb,
    metadata: { ...orb.metadata, provenance: { provider: "scenario", generator: "createSyntheticGlb" } },
  });
  assert.ok(stolen.some((d) => d.code === "asset.provenance.synthetic.invalidProvider"));

  const paid = validateAssetRecord({
    ...orb,
    metadata: {
      ...orb.metadata,
      provenance: { provider: "kinetra-synthetic", generator: "createSyntheticGlb", creativeUnitsCost: 5 },
    },
  });
  assert.ok(paid.some((d) => d.code === "asset.provenance.synthetic.externalCost"));

  const huge = validateAssetRecord({ ...orb, metadata: { ...orb.metadata, boundsRadius: Number.NaN } });
  assert.ok(huge.some((d) => d.code === "model.bounds.invalid"));
});

test("validateOrbRunAssets reports a missing artifact", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const diagnostics = validateOrbRunAssets(pipeline);
  assert.equal(diagnostics.length, ORB_RUN_ASSET_IDS.length);
  assert.ok(diagnostics.every((d) => d.code === "orbrun.asset.artifactMissing" && d.severity === "error"));
});

test("registering records needs source bytes for every asset", async () => {
  const sources = await createOrbRunAssetSources();
  delete sources[ORB_RUN_AUDIO_ASSET.win];
  assert.throws(() => createOrbRunAssetRecords(sources), /Missing source bytes/);
});
