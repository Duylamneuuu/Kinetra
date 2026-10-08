import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMorphWeight,
  buildMorphTargetCatalog,
  MORPH_WEIGHT_MAX,
  MORPH_WEIGHT_MIN,
  summarizeMorphTargets,
  validateMorphTargetNames,
  validateMorphWeightRequest,
  type MorphTargetMeshDescriptor,
} from "../src/morph-targets.js";
import * as rootExports from "../src/index.js";

function fixture(): MorphTargetMeshDescriptor[] {
  return [
    { meshName: "Face", targetNames: ["smile", "blink"], influences: [0.25, 0] },
    { meshName: "Brow", targetNames: ["blink", "raise"], influences: [0, 0.5] },
  ];
}

test("morph catalog: unique names sorted by code point, shared names bound to every mesh", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  assert.deepEqual(catalog.names, ["blink", "raise", "smile"]);
  assert.deepEqual(catalog.bindings.get("blink"), [
    { meshIndex: 0, influenceIndex: 1 },
    { meshIndex: 1, influenceIndex: 0 },
  ]);
  assert.deepEqual(catalog.bindings.get("smile"), [{ meshIndex: 0, influenceIndex: 0 }]);
});

test("morph catalog: ordering is locale independent (uppercase before lowercase)", () => {
  const catalog = buildMorphTargetCatalog([
    { meshName: "M", targetNames: ["b", "B", "a", "Ä"], influences: [0, 0, 0, 0] },
  ]);
  assert.deepEqual(catalog.names, ["B", "a", "b", "Ä"]);
});

test("morph catalog: skips empty names and slots without an influence", () => {
  const catalog = buildMorphTargetCatalog([
    { meshName: "M", targetNames: ["", "ok", "dangling"], influences: [0, 0] },
  ]);
  assert.deepEqual(catalog.names, ["ok"]);
  assert.equal(catalog.bindings.has("dangling"), false);
});

test("morph catalog: empty input yields an empty catalog", () => {
  const catalog = buildMorphTargetCatalog([]);
  assert.deepEqual(catalog.names, []);
  assert.equal(catalog.bindings.size, 0);
  assert.deepEqual(summarizeMorphTargets(catalog, []), []);
});

test("summarizeMorphTargets reports first-slot weight and deduplicated mesh names", () => {
  const meshes = fixture();
  const catalog = buildMorphTargetCatalog(meshes);
  assert.deepEqual(summarizeMorphTargets(catalog, meshes), [
    { name: "blink", weight: 0, meshes: ["Face", "Brow"] },
    { name: "raise", weight: 0.5, meshes: ["Brow"] },
    { name: "smile", weight: 0.25, meshes: ["Face"] },
  ]);

  const dup = [{ meshName: "Twin", targetNames: ["x", "x"], influences: [0.1, 0.9] }];
  const dupCatalog = buildMorphTargetCatalog(dup);
  assert.deepEqual(summarizeMorphTargets(dupCatalog, dup), [
    { name: "x", weight: 0.1, meshes: ["Twin"] },
  ]);
});

test("validateMorphWeightRequest accepts valid weights, sorts them and normalises -0", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  const result = validateMorphWeightRequest({ smile: 1, blink: -0, raise: 0.5 }, catalog);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, [
    { name: "blink", weight: 0 },
    { name: "raise", weight: 0.5 },
    { name: "smile", weight: 1 },
  ]);
  assert.equal(Object.is(result.value[0]!.weight, -0), false);
});

test("validateMorphWeightRequest accepts the inclusive bounds", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  const result = validateMorphWeightRequest(
    { smile: MORPH_WEIGHT_MIN, blink: MORPH_WEIGHT_MAX },
    catalog,
  );
  assert.equal(result.ok, true);
});

test("validateMorphWeightRequest rejects non-object requests without throwing", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  for (const input of [undefined, null, 1, "smile", [], [["smile", 1]], new Map([["smile", 1]]), new Date()]) {
    const result = validateMorphWeightRequest(input, catalog);
    assert.equal(result.ok, false, `input ${String(input)} must be rejected`);
    if (result.ok) continue;
    assert.equal(result.diagnostics[0]!.code, "anim.morph.invalidRequest");
    assert.ok(result.diagnostics[0]!.remediation.length > 0);
  }
});

test("validateMorphWeightRequest accepts null-prototype records", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  const input = Object.create(null) as Record<string, number>;
  input.smile = 0.3;
  const result = validateMorphWeightRequest(input, catalog);
  assert.equal(result.ok, true);
});

test("validateMorphWeightRequest rejects an empty request", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  const result = validateMorphWeightRequest({}, catalog);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.diagnostics[0]!.code, "anim.morph.emptyRequest");
});

test("validateMorphWeightRequest is all-or-nothing and reports every bad entry", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  const result = validateMorphWeightRequest(
    { smile: 0.5, frown: 1, blink: Number.NaN, raise: 1.5, SMILE: 0.1 },
    catalog,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  const codes = result.diagnostics.map((d) => d.code);
  assert.deepEqual(codes, [
    "anim.morph.unknownTarget",
    "anim.morph.weightNotFinite",
    "anim.morph.weightOutOfRange",
    "anim.morph.unknownTarget",
  ]);
  const frown = result.diagnostics[0]!;
  assert.match(frown.remediation, /blink, raise, smile/);
  const upper = result.diagnostics[3]!;
  assert.match(upper.remediation, /case-sensitive; did you mean "smile"/);
});

test("validateMorphWeightRequest rejects non-number weights, Infinity and negatives", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  const cases: Array<[unknown, string]> = [
    ["0.5", "anim.morph.weightNotFinite"],
    [null, "anim.morph.weightNotFinite"],
    [true, "anim.morph.weightNotFinite"],
    [Number.POSITIVE_INFINITY, "anim.morph.weightNotFinite"],
    [-0.0001, "anim.morph.weightOutOfRange"],
    [1.0001, "anim.morph.weightOutOfRange"],
  ];
  for (const [weight, code] of cases) {
    const result = validateMorphWeightRequest({ smile: weight }, catalog);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.diagnostics[0]!.code, code, `weight ${String(weight)}`);
  }
});

test("unknown target remediation explains a model without morph targets", () => {
  const catalog = buildMorphTargetCatalog([]);
  const result = validateMorphWeightRequest({ smile: 1 }, catalog);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.diagnostics[0]!.remediation, /no morph targets/);
});

test("unknown target remediation truncates long name lists", () => {
  const names = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const catalog = buildMorphTargetCatalog([
    { meshName: "Many", targetNames: names, influences: names.map(() => 0) },
  ]);
  const result = validateMorphWeightRequest({ nope: 1 }, catalog);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const remediation = result.diagnostics[0]!.remediation;
  assert.match(remediation, /t19, \.\.\.\.$/);
  assert.equal(remediation.includes("t20"), false);
});

test("validateMorphTargetNames: undefined means clear everything", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  assert.deepEqual(validateMorphTargetNames(undefined, catalog), { ok: true, value: undefined });
});

test("validateMorphTargetNames dedupes and sorts valid names", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  assert.deepEqual(validateMorphTargetNames(["smile", "blink", "smile"], catalog), {
    ok: true,
    value: ["blink", "smile"],
  });
  assert.deepEqual(validateMorphTargetNames([], catalog), { ok: true, value: [] });
});

test("validateMorphTargetNames rejects malformed lists and unknown names", () => {
  const catalog = buildMorphTargetCatalog(fixture());
  for (const input of [null, "smile", { smile: true }, ["smile", 1]]) {
    const result = validateMorphTargetNames(input, catalog);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.diagnostics[0]!.code, "anim.morph.invalidRequest");
  }
  const unknown = validateMorphTargetNames(["smile", "frown"], catalog);
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.deepEqual(unknown.diagnostics.map((d) => d.code), ["anim.morph.unknownTarget"]);
});

test("applyMorphWeight writes every bound slot and ignores unknown names", () => {
  const meshes = fixture();
  const catalog = buildMorphTargetCatalog(meshes);
  const influences = meshes.map((m) => [...m.influences]);
  assert.equal(applyMorphWeight(catalog, influences, "blink", 0.75), 2);
  assert.deepEqual(influences, [
    [0.25, 0.75],
    [0.75, 0.5],
  ]);
  assert.equal(applyMorphWeight(catalog, influences, "frown", 1), 0);
  assert.deepEqual(influences, [
    [0.25, 0.75],
    [0.75, 0.5],
  ]);
});

test("applyMorphWeight tolerates missing or shorter influence arrays", () => {
  const meshes = fixture();
  const catalog = buildMorphTargetCatalog(meshes);
  const influences: number[][] = [[0]];
  assert.equal(applyMorphWeight(catalog, influences, "blink", 1), 0);
  assert.deepEqual(influences, [[0]]);
});

test("morph-target contract is re-exported from the package root", () => {
  assert.equal(rootExports.buildMorphTargetCatalog, buildMorphTargetCatalog);
  assert.equal(rootExports.validateMorphWeightRequest, validateMorphWeightRequest);
});
