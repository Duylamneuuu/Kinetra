import assert from "node:assert/strict";
import test from "node:test";

import { hashBytes, inspectGlb, measureGlbDimensions, normalizeGlb, validateAssetRecord } from "@kinetra/asset-pipeline";

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
  MemoryFileSystem,
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
  assert.equal(win.metadata.sampleRate, 22050);
  assert.equal(win.metadata.channels, 1);
  assert.equal(win.metadata.durationSeconds, 0.6);
  assert.equal(win.metadata.provenance?.provider, "kinetra-synthetic");
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
  assert.deepEqual(result.diagnostics?.map((d) => [d.severity, d.code]), [["warning", "asset.wav.sampleRate"]]);
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

// ---- #231 items 3-5: importer metadata is measured/parsed, not copied -------------------------------

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

/** Splices extra bytes into a synthetic WAV right after the 12-byte RIFF header (before `fmt `). */
function wavWithChunkBefore(wav: Uint8Array, chunk: number[]): Uint8Array {
  const out = new Uint8Array(wav.byteLength + chunk.length);
  out.set(wav.subarray(0, 12), 0);
  out.set(chunk, 12);
  out.set(wav.subarray(12), 12 + chunk.length);
  new DataView(out.buffer).setUint32(4, out.byteLength - 8, true);
  return out;
}

test("the GLB importer records the measured size and warns when the declared size lies", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const id = ORB_RUN_MODEL_ASSET.orb; // geometry is a 0.6 m cube
  const record = pipeline.database.get(id)!;
  pipeline.database.upsert({ ...record, recipe: { ...record.recipe, settings: { size: [2, 2, 2] } } });
  const result = await pipeline.service.reimport(id);
  assert.equal(result.status, "reimported");
  assert.deepEqual(result.diagnostics?.map((d) => [d.severity, d.code]), [["warning", "orbrun.model.sizeMismatch"]]);
  const metadata = pipeline.database.get(id)!.metadata;
  assert.deepEqual(metadata.dimensions, [0.6, 0.6, 0.6], "measured, not the declared [2, 2, 2]");
  assert.equal(metadata.boundsRadius, Math.round((Math.hypot(0.6, 0.6, 0.6) / 2) * 1e6) / 1e6);
});

test("the GLB importer measures the geometry when no size is declared and stays quiet when it matches", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const id = ORB_RUN_MODEL_ASSET.player;
  const record = pipeline.database.get(id)!;
  pipeline.database.upsert({ ...record, recipe: { ...record.recipe, settings: {} } });
  const bare = await pipeline.service.reimport(id);
  assert.equal(bare.status, "reimported");
  assert.deepEqual(bare.diagnostics ?? [], []);
  assert.deepEqual(pipeline.database.get(id)!.metadata.dimensions, [0.6, 1.7, 0.6]);

  const built = await buildOrbRunAssets();
  assert.ok(built.results.every((r) => (r.diagnostics ?? []).length === 0), "declared sizes match the generated geometry");
  const measured = await measureGlbDimensions(built.fileSystem.files.get(orbRunImportedPath(ORB_RUN_MODEL_ASSET.exitPad))!);
  assert.ok(measured && Math.abs(measured[1]! - 0.1) < 1e-4);
});

test("the WAV importer finds fmt after an extra LIST chunk instead of reading a fixed offset", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const id = ORB_RUN_AUDIO_ASSET.win;
  const list = [...ascii("LIST"), ...le32(8), ...ascii("INFO"), 0x49, 0x53, 0x46, 0x54];
  pipeline.fileSystem.files.set(orbRunSourcePath(id), wavWithChunkBefore(pipeline.sources[id]!, list));
  const result = await pipeline.service.reimport(id);
  assert.equal(result.status, "reimported", result.error);
  assert.deepEqual(result.diagnostics ?? [], [], "22050 Hz as authored, no bogus sample-rate warning");
  assert.equal(pipeline.database.get(id)!.metadata.sampleRate, 22050);
});

test("the WAV importer rejects non-PCM, empty-format and data-less files with a named reason", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const id = ORB_RUN_AUDIO_ASSET.win;
  const good = pipeline.sources[id]!;
  const cases: Array<[string, (bytes: Uint8Array) => void, RegExp]> = [
    ["float format tag", (b) => new DataView(b.buffer).setUint16(20, 3, true), /not PCM WAV/],
    ["zero channels", (b) => new DataView(b.buffer).setUint16(22, 0, true), /invalid fmt chunk/],
    ["zero sample rate", (b) => new DataView(b.buffer).setUint32(24, 0, true), /invalid fmt chunk/],
    ["no data chunk", (b) => b.set(ascii("junk"), 36), /no data chunk/],
    ["data larger than the file", (b) => new DataView(b.buffer).setUint32(40, b.byteLength * 2, true), /truncated data chunk/],
    ["no fmt chunk", (b) => b.set(ascii("junk"), 12), /no fmt chunk/],
  ];
  for (const [label, corrupt, expected] of cases) {
    const bytes = new Uint8Array(good);
    corrupt(bytes);
    pipeline.fileSystem.files.set(orbRunSourcePath(id), bytes);
    const result = await pipeline.service.reimport(id);
    assert.equal(result.status, "failed", label);
    assert.match(result.error ?? "", expected, label);
  }
});

test("MemoryFileSystem.readFile returns a copy, so editing what was read cannot corrupt the disk", async () => {
  const fileSystem = new MemoryFileSystem();
  await fileSystem.writeFile("a.bin", new Uint8Array([1, 2, 3]));
  const first = await fileSystem.readFile("a.bin");
  first[0] = 99;
  assert.deepEqual([...(await fileSystem.readFile("a.bin"))], [1, 2, 3]);
  await fileSystem.rename("a.bin", "b.bin");
  assert.deepEqual([...(await fileSystem.readFile("b.bin"))], [1, 2, 3]);
});
