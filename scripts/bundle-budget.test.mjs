import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateBundleBudget, findInitialChunks, measureBundle } from "./bundle-budget.mjs";

const files = [
  { name: "index.js", rawBytes: 1000, gzipBytes: 400 },
  { name: "chunk.js", rawBytes: 500, gzipBytes: 150 },
];

test("evaluateBundleBudget passes when every metric is within budget", () => {
  const result = evaluateBundleBudget(files, {
    totalJsRawBytes: 1500,
    totalJsGzipBytes: 550,
    largestJsGzipBytes: 400,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.metrics, {
    totalJsRawBytes: 1500,
    totalJsGzipBytes: 550,
    largestJsGzipBytes: 400,
  });
  assert.deepEqual(result.violations, []);
});

test("evaluateBundleBudget reports each exceeded metric with actual and budget", () => {
  const result = evaluateBundleBudget(files, {
    totalJsRawBytes: 1499,
    largestJsGzipBytes: 399,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    { code: "bundle.budgetExceeded", metric: "totalJsRawBytes", actual: 1500, budget: 1499 },
    { code: "bundle.budgetExceeded", metric: "largestJsGzipBytes", actual: 400, budget: 399 },
  ]);
});

test("evaluateBundleBudget rejects unknown metrics, invalid budgets and empty input", () => {
  assert.throws(() => evaluateBundleBudget(files, { totalCssBytes: 1 }), { code: "bundle.unknownMetric" });
  assert.throws(() => evaluateBundleBudget(files, { totalJsRawBytes: 0 }), { code: "bundle.invalidBudget" });
  assert.throws(() => evaluateBundleBudget(files, { totalJsRawBytes: 1.5 }), { code: "bundle.invalidBudget" });
  assert.throws(() => evaluateBundleBudget([], {}), { code: "bundle.noChunks" });
});

test("measureBundle measures only .js files, deterministically, and fails structurally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-bundle-"));
  try {
    await writeFile(join(dir, "b.js"), "console.log('b');".repeat(50));
    await writeFile(join(dir, "a.js"), "export const a = 1;\n");
    await writeFile(join(dir, "a.js.map"), "{}".repeat(1000));
    await writeFile(join(dir, "style.css"), "body{}");
    await mkdir(join(dir, "nested.js"));

    const first = await measureBundle(dir);
    const second = await measureBundle(dir);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((file) => file.name), ["a.js", "b.js"]);
    assert.equal(first[0].rawBytes, 20);
    assert.ok(first[1].gzipBytes < first[1].rawBytes, "repetitive chunk must compress");

    await assert.rejects(measureBundle(join(dir, "missing")), { code: "bundle.assetsMissing" });
    const empty = join(dir, "empty");
    await mkdir(empty);
    await assert.rejects(measureBundle(empty), { code: "bundle.noChunks" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findInitialChunks lists only eager module scripts and modulepreload links", () => {
  const html = `<!doctype html><head>
    <script type="module" crossorigin src="./assets/index-AAA.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/vendor-BBB.js?x=1">
    <link rel="stylesheet" crossorigin href="./assets/index-CCC.css">
    <script src="./assets/classic.js"></script>
    <link rel="modulepreload" href="./assets/vendor-BBB.js">
  </head>`;
  assert.deepEqual(findInitialChunks(html), ["index-AAA.js", "vendor-BBB.js"]);
  assert.deepEqual(findInitialChunks("<html></html>"), []);
});

test("evaluateBundleBudget measures initialJsGzipBytes over the eager chunks only", () => {
  const result = evaluateBundleBudget(files, { initialJsGzipBytes: 399 }, ["chunk.js"]);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.initialJsGzipBytes, 150);
  const failing = evaluateBundleBudget(files, { initialJsGzipBytes: 399 }, ["index.js"]);
  assert.deepEqual(failing.violations, [
    { code: "bundle.budgetExceeded", metric: "initialJsGzipBytes", actual: 400, budget: 399 },
  ]);
  assert.throws(() => evaluateBundleBudget(files, {}, ["missing.js"]), { code: "bundle.initialChunkMissing" });
  assert.throws(() => evaluateBundleBudget(files, { initialJsGzipBytes: 10 }), {
    code: "bundle.initialChunksUnknown",
  });
});
