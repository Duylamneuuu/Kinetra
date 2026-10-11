import assert from "node:assert/strict";
import test from "node:test";

import { buildAssetBrowser, filterAssetBrowser, type AssetBrowserRecord } from "../src/index.js";

function record(
  id: string,
  overrides: Partial<AssetBrowserRecord> & { path?: string; hash?: string } = {},
): AssetBrowserRecord {
  const { path, hash, ...rest } = overrides;
  return {
    id,
    kind: "model",
    source: { path: path ?? `assets/${id}.glb`, contentHash: hash ?? `hash-${id}` },
    importedPath: `imported/${id}.glb`,
    dependencies: [],
    diagnostics: [],
    ...rest,
  };
}

function statusOf(model: ReturnType<typeof buildAssetBrowser>, id: string): string | undefined {
  return model.entries.find((entry) => entry.id === id)?.status;
}

test("a clean database is all fresh and sorted by id regardless of input order", () => {
  const model = buildAssetBrowser([record("b"), record("a"), record("c")]);
  assert.deepEqual(
    model.entries.map((entry) => entry.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(model.summary, { total: 3, fresh: 3, stale: 0, failed: 0 });
  assert.deepEqual(model.invalid, []);
});

test("output is identical for any input order and does not touch the input", () => {
  const records = [
    record("tex", { kind: "texture", dependencies: ["mesh"] }),
    record("mesh", { dependencies: ["base"] }),
    record("base", { kind: "other" }),
    record("sfx", { kind: "audio", path: "audio/sfx.wav" }),
  ];
  const copy = structuredClone(records);
  const forward = buildAssetBrowser(records);
  const backward = buildAssetBrowser([...records].reverse());
  assert.deepEqual(forward, backward);
  assert.deepEqual(records, copy);
});

test("an error diagnostic marks the asset failed and its dependents stale", () => {
  const model = buildAssetBrowser([
    record("mesh", { diagnostics: [{ severity: "error", code: "x", message: "bad" }, { severity: "warning" }] }),
    record("prefab", { dependencies: ["mesh"] }),
    record("level", { dependencies: ["prefab"] }),
    record("unrelated"),
  ]);
  assert.equal(statusOf(model, "mesh"), "failed");
  assert.equal(statusOf(model, "prefab"), "stale");
  assert.equal(statusOf(model, "level"), "stale");
  assert.equal(statusOf(model, "unrelated"), "fresh");
  const mesh = model.entries.find((entry) => entry.id === "mesh")!;
  assert.deepEqual(mesh.diagnosticCounts, { info: 0, warning: 1, error: 1 });
  assert.equal(mesh.issues[0]?.code, "asset.diagnostic.error");
  const level = model.entries.find((entry) => entry.id === "level")!;
  assert.deepEqual(level.issues, [
    { code: "asset.dependency.failed", message: "a dependency failed; rebuild after it", assetIds: ["mesh"] },
  ]);
  assert.deepEqual(model.summary, { total: 4, fresh: 1, stale: 2, failed: 1 });
});

test("a changed source hash makes the asset and its dependents stale; unchecked paths stay fresh", () => {
  const records = [
    record("mesh", { path: "models/mesh.glb", hash: "old" }),
    record("prefab", { dependencies: ["mesh"] }),
    record("sound", { path: "audio/a.wav", hash: "same" }),
    record("other", { path: "other/o.glb", hash: "h" }),
  ];
  const model = buildAssetBrowser(records, {
    currentSourceHashes: { "models/mesh.glb": "new", "audio/a.wav": "same" },
  });
  assert.equal(statusOf(model, "mesh"), "stale");
  assert.equal(model.entries.find((entry) => entry.id === "mesh")?.issues[0]?.code, "asset.source.changed");
  assert.equal(statusOf(model, "prefab"), "stale");
  assert.equal(statusOf(model, "sound"), "fresh");
  assert.equal(statusOf(model, "other"), "fresh");
});

test("an inherited property name is not mistaken for a current hash", () => {
  const model = buildAssetBrowser([record("a", { path: "toString" })], { currentSourceHashes: {} });
  assert.equal(statusOf(model, "a"), "fresh");
});

test("a dependency on an unknown id is failed with the missing ids listed", () => {
  const model = buildAssetBrowser([record("a", { dependencies: ["ghost", "ghost", "phantom"] })]);
  const entry = model.entries[0]!;
  assert.equal(entry.status, "failed");
  assert.deepEqual(entry.dependencies, ["ghost", "phantom"]);
  assert.deepEqual(entry.missingDependencies, ["ghost", "phantom"]);
  assert.deepEqual(entry.issues[0]?.assetIds, ["ghost", "phantom"]);
});

test("dependency cycles are reported, not looped on", () => {
  const model = buildAssetBrowser([
    record("a", { dependencies: ["b"] }),
    record("b", { dependencies: ["c"] }),
    record("c", { dependencies: ["a"] }),
    record("self", { dependencies: ["self"] }),
    record("tail", { dependencies: ["a"] }),
  ]);
  for (const id of ["a", "b", "c", "self"]) {
    assert.equal(statusOf(model, id), "failed", id);
    assert.equal(model.entries.find((entry) => entry.id === id)?.inCycle, true, id);
  }
  const a = model.entries.find((entry) => entry.id === "a")!;
  assert.deepEqual(a.issues.find((issue) => issue.code === "asset.dependency.cycle")?.assetIds, ["b", "c"]);
  assert.equal(statusOf(model, "tail"), "stale");
  assert.equal(model.entries.find((entry) => entry.id === "tail")?.inCycle, false);
});

test("a very long dependency chain does not overflow the stack", () => {
  const length = 20000;
  const records: AssetBrowserRecord[] = [];
  for (let index = 0; index < length; index += 1) {
    records.push(record(`n${String(index).padStart(6, "0")}`, index === 0 ? {} : { dependencies: [`n${String(index - 1).padStart(6, "0")}`] }));
  }
  records[0] = record("n000000", { diagnostics: [{ severity: "error" }] });
  const model = buildAssetBrowser(records);
  assert.equal(model.summary.total, length);
  assert.equal(model.summary.failed, 1);
  assert.equal(model.summary.stale, length - 1);
});

test("dependents are direct reverse edges, sorted", () => {
  const model = buildAssetBrowser([
    record("base"),
    record("z", { dependencies: ["base"] }),
    record("m", { dependencies: ["base", "base"] }),
  ]);
  assert.deepEqual(model.entries.find((entry) => entry.id === "base")?.dependents, ["m", "z"]);
});

test("groups by kind in a fixed order and by folder in text order", () => {
  const model = buildAssetBrowser([
    record("s", { kind: "audio", path: "audio\\fx\\s.wav" }),
    record("m", { kind: "model", path: "models/m.glb" }),
    record("x", { kind: "weird", path: "x.bin" }),
    record("t", { kind: "texture", path: "./textures/t.png" }),
    record("o", { kind: "other", path: "models/o.bin" }),
  ]);
  assert.deepEqual(
    model.byKind.map((group) => group.key),
    ["model", "texture", "audio", "other", "weird"],
  );
  assert.deepEqual(
    model.byFolder.map((group) => [group.key, group.assetIds]),
    [
      ["", ["x"]],
      ["audio/fx", ["s"]],
      ["models", ["m", "o"]],
      ["textures", ["t"]],
    ],
  );
  assert.equal(model.entries.find((entry) => entry.id === "s")?.name, "s.wav");
});

test("malformed records are skipped and reported without throwing", () => {
  const bad: unknown[] = [
    null,
    "text",
    { id: "" },
    { id: "no-kind" },
    { id: "no-source", kind: "model" },
    { id: "bad-deps", kind: "model", source: { path: "p", contentHash: "h" }, importedPath: "i", dependencies: "abc" },
    { id: "bad-dep-item", kind: "model", source: { path: "p", contentHash: "h" }, importedPath: "i", dependencies: [1] },
    { id: "bad-diag", kind: "model", source: { path: "p", contentHash: "h" }, importedPath: "i", dependencies: [], diagnostics: 5 },
    record("good"),
    record("good", { kind: "texture" }),
  ];
  const model = buildAssetBrowser(bad as AssetBrowserRecord[]);
  assert.deepEqual(model.entries.map((entry) => entry.id), ["good"]);
  assert.equal(model.entries[0]?.kind, "model", "first duplicate wins");
  assert.equal(model.invalid.length, 9);
  assert.deepEqual(model.invalid.map((item) => item.index), [0, 1, 2, 3, 4, 5, 6, 7, 9]);
  assert.match(model.invalid[8]!.message, /duplicate asset id "good"/);
});

test("a non-array input yields an empty model with one invalid note", () => {
  const model = buildAssetBrowser(undefined as unknown as AssetBrowserRecord[]);
  assert.equal(model.entries.length, 0);
  assert.equal(model.invalid.length, 1);
});

test("a diagnostic with an unknown severity is ignored in the counts", () => {
  const model = buildAssetBrowser([record("a", { diagnostics: [{ severity: "fatal" }, { severity: "info" }, null as never] })]);
  assert.deepEqual(model.entries[0]?.diagnosticCounts, { info: 1, warning: 0, error: 0 });
  assert.equal(model.entries[0]?.status, "fresh");
});

test("filterAssetBrowser combines kind, status, folder and search", () => {
  const model = buildAssetBrowser(
    [
      record("hero", { path: "models/hero.glb" }),
      record("Hero_tex", { kind: "texture", path: "textures/hero.png", diagnostics: [{ severity: "error" }] }),
      record("rock", { path: "models/rock.glb" }),
    ],
    {},
  );
  assert.deepEqual(filterAssetBrowser(model, {}).map((entry) => entry.id), ["Hero_tex", "hero", "rock"]);
  assert.deepEqual(filterAssetBrowser(model, { kinds: ["texture"] }).map((entry) => entry.id), ["Hero_tex"]);
  assert.deepEqual(filterAssetBrowser(model, { statuses: ["failed"] }).map((entry) => entry.id), ["Hero_tex"]);
  assert.deepEqual(filterAssetBrowser(model, { folder: "models" }).map((entry) => entry.id), ["hero", "rock"]);
  assert.deepEqual(filterAssetBrowser(model, { search: "HERO" }).map((entry) => entry.id), ["Hero_tex", "hero"]);
  assert.deepEqual(filterAssetBrowser(model, { search: "hero", kinds: ["model"] }).map((entry) => entry.id), ["hero"]);
  assert.deepEqual(filterAssetBrowser(model, { search: "" }).length, 3);
  assert.deepEqual(filterAssetBrowser(model, { kinds: [] }), []);
});

test("ids sort by UTF-16 code unit, not locale", () => {
  const model = buildAssetBrowser([record("b"), record("B"), record("a"), record("é"), record("Z")]);
  assert.deepEqual(model.entries.map((entry) => entry.id), ["B", "Z", "a", "b", "é"]);
});
