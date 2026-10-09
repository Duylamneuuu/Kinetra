import assert from "node:assert/strict";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  importFingerprint,
  inspectGlb,
  normalizeGlb,
  validateAssetRecord,
  type AssetRecord,
} from "../src/index.js";

function record(overrides: Partial<AssetRecord> = {}): AssetRecord {
  const sourceHash = "b".repeat(64);
  const recipe = { importer: "blender-glb", importerVersion: "1", settings: {} };
  return {
    id: "prop",
    kind: "model",
    source: { path: "assets/source/prop.blend", kind: "source", contentHash: sourceHash },
    importedPath: "assets/imported/prop.glb",
    recipe,
    fingerprint: importFingerprint({ sourceHash, importer: "blender-glb", importerVersion: "1", settings: {} }),
    dependencies: [],
    diagnostics: [],
    metadata: {},
    ...overrides,
  };
}

function codes(value: AssetRecord): string[] {
  return validateAssetRecord(value).map((d) => d.code);
}

function glbHeader(version: number, declaredLength: number, actualLength: number): Uint8Array {
  const bytes = new Uint8Array(actualLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, version, true);
  view.setUint32(8, declaredLength, true);
  return bytes;
}

test("a clean record produces no diagnostics", () => {
  assert.deepEqual(validateAssetRecord(record()), []);
});

test("required structural fields each report their own error code", () => {
  assert.deepEqual(codes(record({ importedPath: "" })), ["asset.imported.path.empty"]);
  assert.deepEqual(
    codes(record({ recipe: { importer: "", importerVersion: "1", settings: {} } })),
    ["asset.recipe.importer.empty"],
  );
  const source = { path: "", kind: "source" as const, contentHash: "b".repeat(64) };
  assert.deepEqual(codes(record({ source })), ["asset.source.path.empty"]);
});

test("hashes must be lowercase 64-char sha256 hex", () => {
  for (const bad of ["", "b".repeat(63), "b".repeat(65), "B".repeat(64), "g".repeat(64), `${"b".repeat(63)}\n`]) {
    const source = { path: "x.blend", kind: "source" as const, contentHash: bad };
    assert.ok(codes(record({ source })).includes("asset.source.hash.invalid"), `contentHash ${JSON.stringify(bad)}`);
    assert.ok(codes(record({ fingerprint: bad })).includes("asset.fingerprint.invalid"), `fingerprint ${JSON.stringify(bad)}`);
  }
});

test("polycount must be a non-negative safe integer; only large valid counts warn", () => {
  const invalid = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  for (const polycount of invalid) {
    const diagnostics = validateAssetRecord(record({ metadata: { polycount } }));
    assert.deepEqual(diagnostics.map((d) => [d.severity, d.code]), [["error", "model.polycount.invalid"]], `polycount ${polycount}`);
  }
  assert.deepEqual(codes(record({ metadata: { polycount: 0 } })), []);
  assert.deepEqual(codes(record({ metadata: { polycount: 2_000_000 } })), [], "threshold itself is allowed");
  const high = validateAssetRecord(record({ metadata: { polycount: 2_000_001 } }));
  assert.deepEqual(high.map((d) => [d.severity, d.code]), [["warning", "model.polycount.high"]]);
});

test("texture dimension follows the same integer rule with an 8192 warning threshold", () => {
  for (const maxTextureDimension of [-4, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(codes(record({ metadata: { maxTextureDimension } })), ["texture.dimension.invalid"], `dimension ${maxTextureDimension}`);
  }
  assert.deepEqual(codes(record({ metadata: { maxTextureDimension: 8192 } })), []);
  assert.deepEqual(codes(record({ metadata: { maxTextureDimension: 8193 } })), ["texture.dimension.high"]);
});

test("bounds radius must be a positive finite number", () => {
  for (const boundsRadius of [0, -0.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(codes(record({ metadata: { boundsRadius } })), ["model.bounds.invalid"], `radius ${boundsRadius}`);
  }
  assert.deepEqual(codes(record({ metadata: { boundsRadius: 500 } })), []);
  assert.deepEqual(codes(record({ metadata: { boundsRadius: 500.5 } })), ["model.bounds.large"]);
});

test("non-numeric metadata values are ignored by the numeric checks", () => {
  const metadata = { polycount: "many", maxTextureDimension: null, boundsRadius: "big" } as unknown as AssetRecord["metadata"];
  assert.deepEqual(codes(record({ metadata })), []);
});

test("diagnostics accumulate rather than stopping at the first failure", () => {
  const value = record({
    importedPath: "",
    fingerprint: "nope",
    metadata: { polycount: -3, boundsRadius: 0 },
  });
  assert.deepEqual(codes(value).sort(), [
    "asset.fingerprint.invalid",
    "asset.imported.path.empty",
    "model.bounds.invalid",
    "model.polycount.invalid",
  ]);
});

test("synthetic detection is case-insensitive on the generator and external providers cannot hide behind it", () => {
  const external = validateAssetRecord(
    record({ metadata: { provenance: { provider: "scenario", generator: "KINETRA-fixture-maker" } } }),
  );
  assert.deepEqual(external.map((d) => d.code), ["asset.provenance.synthetic.invalidProvider"]);

  // A generator that merely contains "kinetra" later in the string is not a synthetic fixture.
  const unrelated = validateAssetRecord(
    record({ metadata: { provenance: { provider: "scenario", generator: "my-kinetra-exporter" } } }),
  );
  assert.deepEqual(unrelated, []);
});

test("every synthetic provider alias is held to the no-external-claims rule", () => {
  for (const provider of ["kinetra", "kinetra-synthetic", "synthetic"]) {
    const diagnostics = validateAssetRecord(
      record({
        metadata: {
          provenance: { provider, creativeUnitsCost: 0.5, sourceAssetId: "ext-1", model: "Claude-Opus" },
        },
      }),
    );
    assert.deepEqual(
      diagnostics.map((d) => d.code).sort(),
      [
        "asset.provenance.synthetic.externalAssetId",
        "asset.provenance.synthetic.externalCost",
        "asset.provenance.synthetic.externalModel",
      ],
      provider,
    );
  }
});

test("zero or absent creative-unit cost is fine for synthetic fixtures; external providers may charge", () => {
  assert.deepEqual(
    codes(record({ metadata: { provenance: { provider: "kinetra", creativeUnitsCost: 0 } } })),
    [],
  );
  assert.deepEqual(
    codes(record({ metadata: { provenance: { provider: "scenario", creativeUnitsCost: 25, sourceAssetId: "a1", model: "gpt-x" } } })),
    [],
  );
});

test("inspectGlb rejects unsupported versions and length mismatches with specific messages", () => {
  assert.throws(() => inspectGlb(glbHeader(1, 12, 12)), /Unsupported GLB version 1/);
  assert.throws(() => inspectGlb(glbHeader(3, 12, 12)), /Unsupported GLB version 3/);
  assert.throws(() => inspectGlb(glbHeader(2, 20, 12)), /declared length 20 does not match 12/);
  assert.throws(() => inspectGlb(glbHeader(2, 12, 16)), /declared length 12 does not match 16/);
});

test("inspectGlb rejects anything shorter than the 12-byte header", () => {
  for (let size = 0; size < 12; size += 1) {
    assert.throws(() => inspectGlb(new Uint8Array(size)), /12-byte header/, `size ${size}`);
  }
});

test("inspectGlb honours the byteOffset of a subarray view", () => {
  const inner = glbHeader(2, 12, 12);
  const backing = new Uint8Array(40);
  backing.set(inner, 17);
  const view = backing.subarray(17, 29);
  assert.deepEqual(inspectGlb(view), { magic: 0x46546c67, version: 2, length: 12 });
  // The same backing buffer read from the wrong offset must not pass.
  assert.throws(() => inspectGlb(backing.subarray(16, 28)), /magic/i);
});

test("inspectGlb never throws anything but Error for deterministic pseudo-random headers", () => {
  let seed = 0x2545f491;
  const next = (): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed;
  };
  let accepted = 0;
  for (let i = 0; i < 500; i += 1) {
    const size = next() % 40;
    const bytes = new Uint8Array(size);
    for (let j = 0; j < size; j += 1) bytes[j] = next() & 0xff;
    // Make a share of cases structurally plausible so the later checks run.
    if (size >= 12 && i % 3 === 0) {
      const view = new DataView(bytes.buffer);
      view.setUint32(0, 0x46546c67, true);
      view.setUint32(4, i % 2 === 0 ? 2 : next() % 5, true);
      view.setUint32(8, i % 4 === 0 ? size : next() % 64, true);
    }
    try {
      const header = inspectGlb(bytes);
      accepted += 1;
      assert.equal(header.magic, 0x46546c67);
      assert.equal(header.version, 2);
      assert.equal(header.length, bytes.byteLength);
    } catch (error) {
      assert.ok(error instanceof Error, `iteration ${i} threw a non-Error`);
    }
  }
  assert.ok(accepted > 0, "the generator should produce some valid headers");
});

test("normalizeGlb reports scene statistics and a re-readable GLB", async () => {
  const document = new Document();
  document.createBuffer();
  const scene = document.createScene("Main");
  const parent = document.createNode("Parent");
  const child = document.createNode("Child");
  parent.addChild(child);
  scene.addChild(parent);
  const material = document.createMaterial("Red").setBaseColorFactor([1, 0, 0, 1]);
  void material;

  const input = await new NodeIO().writeBinary(document);
  const result = await normalizeGlb(input);

  assert.equal(result.nodeCount, 2);
  assert.equal(result.meshCount, 0);
  assert.equal(result.animationCount, 0);
  assert.equal(result.materialCount, 1);
  assert.equal(result.textureCount, 0);
  assert.equal(result.beforeBytes, input.byteLength);
  assert.equal(result.afterBytes, result.bytes.byteLength);
  assert.equal(inspectGlb(result.bytes).length, result.bytes.byteLength);

  // Normalising is idempotent after the first pass.
  const again = await normalizeGlb(result.bytes);
  assert.deepEqual(Buffer.from(again.bytes), Buffer.from(result.bytes));
});

test("normalizeGlb rejects bytes that are not a GLB instead of returning garbage", async () => {
  await assert.rejects(() => normalizeGlb(new Uint8Array(0)));
  await assert.rejects(() => normalizeGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])));
  await assert.rejects(() => normalizeGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}}')));
});
