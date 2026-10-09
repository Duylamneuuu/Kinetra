import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const COVERAGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "coverage.mjs");

function runCoverage(cwd, args = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [COVERAGE_SCRIPT, ...args], { cwd, env, encoding: "utf8" });
}

async function writeFixture(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

test("coverage.mjs end to end: runs registered unit tests, writes lcov and summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-coverage-e2e-"));
  try {
    await writeFixture(root, {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": JSON.stringify({ name: "@x/a", scripts: { test: "node --test dist/test/*.test.js" } }),
      "packages/a/dist/src/lib.js": "export function pick(flag) {\n  if (flag) {\n    return 1;\n  }\n  return 2;\n}\nexport function unused() {\n  return 3;\n}\n",
      "packages/a/dist/test/lib.test.js":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { pick } from "../src/lib.js";\ntest("pick", () => assert.equal(pick(true), 1));\n',
      "packages/a/dist/test/real-electron.test.js": 'import test from "node:test";\ntest("real", () => { throw new Error("must be skipped"); });\n',
      "packages/b/package.json": JSON.stringify({ name: "@x/b", scripts: { build: "tsc" } }),
    });
    const result = runCoverage(root, ["--out", "cov"]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const summary = JSON.parse(await readFile(join(root, "cov/summary.json"), "utf8"));
    assert.equal(summary.length, 1);
    assert.equal(summary[0].packageName, "@x/a");
    assert.equal(summary[0].testFiles, 1);
    assert.equal(summary[0].summary.files, 1);
    assert.ok(summary[0].summary.lines.pct < 100 && summary[0].summary.lines.pct > 0);
    assert.equal(summary[0].summary.functions.found, 2);
    assert.equal(summary[0].summary.functions.hit, 1);
    assert.match(await readFile(join(root, "cov/x__a.lcov"), "utf8"), /SF:.*lib\.js/);
    const markdown = await readFile(join(root, "cov/summary.md"), "utf8");
    assert.match(markdown, /\| @x\/a \| 1 \|/);
    assert.match(markdown, /compiled JavaScript/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage.mjs exits non-zero when nothing is built or a package's tests fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-coverage-e2e-"));
  try {
    await writeFixture(root, {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": JSON.stringify({ name: "@x/a", scripts: { test: "node --test dist/test/*.test.js" } }),
    });
    const unbuilt = runCoverage(root, ["--out", "cov"]);
    assert.equal(unbuilt.status, 1);
    assert.match(unbuilt.stderr, /pnpm build/);

    await writeFixture(root, {
      "packages/a/dist/src/lib.js": "export const one = () => 1;\n",
      "packages/a/dist/test/lib.test.js":
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { one } from "../src/lib.js";\ntest("one", () => assert.equal(one(), 2));\n',
    });
    const failing = runCoverage(root, ["--out", "cov"]);
    assert.equal(failing.status, 1);
    const summary = JSON.parse(await readFile(join(root, "cov/summary.json"), "utf8"));
    assert.match(summary[0].error, /tests exited with/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage.mjs rejects workspace patterns it cannot expand", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-coverage-e2e-"));
  try {
    await writeFixture(root, { "pnpm-workspace.yaml": 'packages:\n  - "packages/**"\n' });
    const result = runCoverage(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported pnpm workspace pattern/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
