import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractTestReferences,
  isPackageSourceFile,
  isRealElectronTest,
  parseLcov,
  percent,
  renderMarkdown,
  resolveTestFiles,
  summarize,
} from "./coverage.mjs";

const LCOV = `TN:
SF:/repo/packages/a/dist/src/index.js
FNF:4
FNH:3
BRF:10
BRH:5
LF:100
LH:80
end_of_record
SF:/repo/packages/a/dist/test/a.test.js
FNF:2
FNH:2
LF:20
LH:20
end_of_record
SF:/repo/packages/a/dist/src/empty.js
LF:0
LH:0
end_of_record
`;

test("parseLcov reads per-file line, branch and function counts", () => {
  const records = parseLcov(LCOV);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    file: "/repo/packages/a/dist/src/index.js",
    lines: { found: 100, hit: 80 },
    branches: { found: 10, hit: 5 },
    functions: { found: 4, hit: 3 },
  });
  assert.deepEqual(records[1].branches, { found: 0, hit: 0 });
});

test("parseLcov ignores data outside records, malformed counts and CRLF", () => {
  const records = parseLcov("LF:9\r\nSF:x.js\r\nLF:abc\r\nLF:4\r\nLH:2\r\nend_of_record\r\nLH:7\r\n");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].lines, { found: 4, hit: 2 });
  assert.deepEqual(parseLcov(""), []);
});

test("percent rounds to one decimal, clamps and treats empty metrics as covered", () => {
  assert.equal(percent({ found: 3, hit: 1 }), 33.3);
  assert.equal(percent({ found: 0, hit: 0 }), 100);
  assert.equal(percent({ found: 2, hit: 5 }), 100);
});

test("summarize totals only the files the filter keeps", () => {
  const records = parseLcov(LCOV);
  const summary = summarize(records, (file) => file.includes("/dist/src/"));
  assert.deepEqual(summary, {
    files: 2,
    lines: { found: 100, hit: 80, pct: 80 },
    branches: { found: 10, hit: 5, pct: 50 },
    functions: { found: 4, hit: 3, pct: 75 },
  });
  assert.equal(summarize([]).files, 0);
  assert.equal(summarize([]).lines.pct, 100);
});

test("renderMarkdown prints a row per package and flags errors", () => {
  const records = parseLcov(LCOV);
  const markdown = renderMarkdown([
    { packageName: "@x/a", summary: summarize(records) },
    { packageName: "@x/b", error: "no runnable unit tests (build first?)" },
  ]);
  assert.match(markdown, /^\| Package \| Files \| Lines % \| Branches % \| Functions % \|/);
  assert.match(markdown, /\| @x\/a \| 3 \| 83\.3 \| 50 \| 83\.3 \|/);
  assert.match(markdown, /\| @x\/b \|.*no runnable unit tests/);
});

test("extractTestReferences reads explicit paths and globs from a test script", () => {
  assert.deepEqual(
    extractTestReferences("node --test --test-concurrency=1 dist/test/a.test.js ./dist/test/b.test.js 'dist/test/*.test.js'"),
    ["dist/test/a.test.js", "dist/test/b.test.js", "dist/test/*.test.js"],
  );
  assert.deepEqual(extractTestReferences(undefined), []);
  assert.deepEqual(extractTestReferences("tsc -p tsconfig.json"), []);
});

test("isRealElectronTest matches only real-* acceptance tests", () => {
  assert.equal(isRealElectronTest("dist/test/real-ik-bridge.test.js"), true);
  assert.equal(isRealElectronTest("dist/test/visual.test.js"), false);
  assert.equal(isRealElectronTest("dist/test/surreal-x.test.js"), false);
});

test("resolveTestFiles expands globs and keeps explicit files that exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-coverage-"));
  try {
    await mkdir(join(dir, "dist/test/nested"), { recursive: true });
    for (const file of ["a.test.js", "b.test.js", "helper.js", "nested/c.test.js"]) {
      await writeFile(join(dir, "dist/test", file), "");
    }
    assert.deepEqual(await resolveTestFiles(dir, "node --test dist/test/*.test.js"), [
      "dist/test/a.test.js",
      "dist/test/b.test.js",
    ]);
    assert.deepEqual(await resolveTestFiles(dir, "node --test dist/test/**/*.test.js"), [
      "dist/test/a.test.js",
      "dist/test/b.test.js",
      "dist/test/nested/c.test.js",
    ]);
    assert.deepEqual(await resolveTestFiles(dir, "node --test dist/test/b.test.js dist/test/missing.test.js"), [
      "dist/test/b.test.js",
    ]);
    assert.deepEqual(await resolveTestFiles(join(dir, "nope"), "node --test dist/test/*.test.js"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isPackageSourceFile keeps dist sources and drops tests, dependencies and outside files", () => {
  const pkg = "/repo/packages/a";
  assert.equal(isPackageSourceFile(pkg, "/repo/packages/a/dist/src/index.js"), true);
  assert.equal(isPackageSourceFile(pkg, "/repo/packages/a/dist/scripts.js"), true);
  assert.equal(isPackageSourceFile(pkg, "dist/src/relative.js"), true);
  assert.equal(isPackageSourceFile(pkg, "/repo/packages/a/dist/test/a.test.js"), false);
  assert.equal(isPackageSourceFile(pkg, "/repo/packages/a/src/index.ts"), false);
  assert.equal(isPackageSourceFile(pkg, "/repo/packages/b/dist/src/index.js"), false);
  assert.equal(isPackageSourceFile(pkg, "/repo/packages/ab/dist/src/index.js"), false);
  assert.equal(isPackageSourceFile(pkg, "/repo/packages/a/dist/node_modules/x/index.js"), false);
});
