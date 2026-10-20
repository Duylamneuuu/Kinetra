import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticWav } from "@kinetra/audio";

import {
  AssetDatabase,
  AssetReimportService,
  WavImportError,
  WavImporter,
  hashBytes,
  importFingerprint,
  inspectWav,
  type AssetImporterContext,
  type AssetRecord,
  type FileSystemAdapter,
} from "../src/index.js";

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

function audioRecord(importer: string, source: Uint8Array, metadata: AssetRecord["metadata"]): AssetRecord {
  const recipe = { importer, importerVersion: "1", settings: { sampleRate: 8000 } };
  const sourceHash = hashBytes(source);
  return {
    id: "cue",
    kind: "audio",
    source: { path: "src/cue.wav", kind: "source", contentHash: sourceHash },
    importedPath: "out/cue.wav",
    recipe,
    fingerprint: importFingerprint({ sourceHash, ...recipe }),
    dependencies: [],
    diagnostics: [],
    metadata,
  };
}

function context(bytes: Uint8Array, settings: Record<string, unknown> = {}): AssetImporterContext {
  return {
    assetId: "cue",
    sourcePath: "src/cue.wav",
    sourceBytes: bytes,
    sourceHash: hashBytes(bytes),
    recipe: { importer: "wav", importerVersion: "1", settings },
    targetPath: "out/cue.wav",
  };
}

test("inspectWav reads sampleRate, channels and duration from createSyntheticWav", () => {
  const wav = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.1, frequency: 440 });
  const info = inspectWav(wav, "cue");
  assert.equal(info.sampleRate, 8000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataBytes, 8000 * 0.1 * 2);
  assert.equal(info.durationSeconds, 0.1);
});

test("WavImporter copies the bytes and warns when the recipe sample rate disagrees", async () => {
  const wav = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.1, frequency: 0 });
  const imported = await new WavImporter().import(context(wav, { sampleRateHz: 44100 }));
  assert.deepEqual(imported.artifactBytes, wav);
  assert.equal(imported.metadata?.sampleRate, 8000);
  assert.equal(imported.metadata?.channels, 1);
  assert.equal(imported.metadata?.durationSeconds, 0.1);
  assert.deepEqual(imported.diagnostics?.map((diagnostic) => diagnostic.code), ["asset.wav.sampleRate"]);

  const matched = await new WavImporter().import(context(wav, { sampleRate: 8000 }));
  assert.equal(matched.diagnostics, undefined);
});

test("reimport through wav and audio keeps metadata the importer does not write", async () => {
  const wav = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.1, frequency: 220 });
  const provenance = { provider: "kinetra-synthetic", generator: "createSyntheticWav", license: "CC0-1.0" };
  for (const importer of ["wav", "audio"]) {
    const record = audioRecord(importer, wav, { provenance, polycount: 3, durationSeconds: 9 });
    const files = new Map<string, Uint8Array>([[record.source.path, wav]]);
    const database = new AssetDatabase();
    database.upsert(record);
    const service = new AssetReimportService({ database, fileSystem: memoryFs(files) });
    assert.ok(service.getImporter(importer) instanceof WavImporter);
    const result = await service.reimport(record.id);
    assert.equal(result.status, "reimported", result.error);
    const stored = database.get(record.id)!;
    assert.equal(stored.metadata.sampleRate, 8000);
    assert.equal(stored.metadata.channels, 1);
    assert.equal(stored.metadata.durationSeconds, 0.1);
    assert.equal(stored.metadata.polycount, 3);
    assert.deepEqual(stored.metadata.provenance, provenance);
    assert.deepEqual(files.get(record.importedPath), wav);
  }
  const service = new AssetReimportService({ database: new AssetDatabase(), fileSystem: memoryFs(new Map()) });
  assert.equal(service.getImporter("wav"), service.getImporter("audio"));
});

test("a truncated header, a bad magic and a data chunk past the end of the file are coded errors", () => {
  const cases: Array<[string, Uint8Array, WavImportError["code"], RegExp]> = [
    ["truncated header", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]), "asset.wav.truncated", /truncated WAV header/],
    ["wrong magic", new TextEncoder().encode("RIFFxxxxAVI "), "asset.wav.notRiff", /not a RIFF\/WAVE file/],
    [
      "data past the end",
      (() => {
        const wav = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.01, frequency: 0 });
        const broken = wav.slice();
        new DataView(broken.buffer).setUint32(40, broken.byteLength * 2, true);
        return broken;
      })(),
      "asset.wav.truncated",
      /truncated data chunk/,
    ],
  ];
  for (const [label, bytes, code, pattern] of cases) {
    assert.throws(
      () => inspectWav(bytes, "cue"),
      (error: unknown) => {
        assert.ok(error instanceof WavImportError, label);
        assert.equal(error.code, code, label);
        assert.match(error.message, pattern, label);
        assert.ok(error.message.includes(error.remediation), label);
        assert.ok(error.remediation.length > 0, label);
        return true;
      },
    );
  }
});

test("a failed wav reimport leaves the last good artifact and the record's other metadata", async () => {
  const wav = createSyntheticWav({ sampleRate: 8000, durationSeconds: 0.05, frequency: 440 });
  const record = audioRecord("wav", wav, {
    provenance: { provider: "kinetra-synthetic", generator: "createSyntheticWav" },
  });
  const files = new Map<string, Uint8Array>([[record.source.path, wav]]);
  const database = new AssetDatabase();
  database.upsert(record);
  const service = new AssetReimportService({ database, fileSystem: memoryFs(files) });
  assert.equal((await service.reimport("cue")).status, "reimported");
  const good = database.get("cue")!;
  const artifact = files.get("out/cue.wav")!.slice();

  files.set("src/cue.wav", new Uint8Array([1, 2, 3, 4]));
  const failed = await service.reimport("cue");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "asset.wav.truncated");
  assert.match(failed.error ?? "", /\[asset\.wav\.truncated\]/);
  assert.deepEqual(database.get("cue"), good);
  assert.deepEqual(files.get("out/cue.wav"), artifact);
});
