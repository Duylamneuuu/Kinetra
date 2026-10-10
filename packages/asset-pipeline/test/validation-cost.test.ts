import assert from "node:assert/strict";
import test from "node:test";
import { importFingerprint, validateAssetRecord, type AssetProvenance, type AssetRecord } from "../src/index.js";

function recordWith(provenance: AssetProvenance): AssetRecord {
  const sourceHash = "c".repeat(64);
  return {
    id: "prop",
    kind: "model",
    source: { path: "assets/source/prop.blend", kind: "source", contentHash: sourceHash },
    importedPath: "assets/imported/prop.glb",
    recipe: { importer: "blender-glb", importerVersion: "1", settings: {} },
    fingerprint: importFingerprint({ sourceHash, importer: "blender-glb", importerVersion: "1", settings: {} }),
    dependencies: [],
    diagnostics: [],
    metadata: { provenance },
  };
}

function codes(provenance: AssetProvenance): string[] {
  return validateAssetRecord(recordWith(provenance)).map((d) => d.code);
}

test("creativeUnitsCost NaN, Infinity and negative values are rejected for synthetic fixtures", () => {
  for (const creativeUnitsCost of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5]) {
    assert.ok(
      codes({ provider: "kinetra", creativeUnitsCost }).includes("asset.provenance.creativeUnitsCost.invalid"),
      `synthetic cost ${creativeUnitsCost}`,
    );
  }
});

test("creativeUnitsCost NaN, Infinity and negative values are rejected for external providers too", () => {
  for (const creativeUnitsCost of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
    assert.deepEqual(
      codes({ provider: "scenario", creativeUnitsCost }),
      ["asset.provenance.creativeUnitsCost.invalid"],
      `external cost ${creativeUnitsCost}`,
    );
  }
});

test("valid creativeUnitsCost values keep their existing behaviour", () => {
  assert.deepEqual(codes({ provider: "scenario", creativeUnitsCost: 0 }), []);
  assert.deepEqual(codes({ provider: "scenario", creativeUnitsCost: 25 }), []);
  assert.deepEqual(codes({ provider: "kinetra", creativeUnitsCost: 0 }), []);
  assert.deepEqual(codes({ provider: "kinetra", creativeUnitsCost: 0.5 }), ["asset.provenance.synthetic.externalCost"]);
});
