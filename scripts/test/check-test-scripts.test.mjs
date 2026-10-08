import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditTestScript,
  auditWorkspace,
  compiledTestPath,
  extractTestReferences,
} from "../check-test-scripts.mjs";

test("compiledTestPath maps test sources into dist", () => {
  assert.equal(compiledTestPath("test/a.test.ts"), "dist/test/a.test.js");
  assert.equal(compiledTestPath("test/nested/b.test.ts"), "dist/test/nested/b.test.js");
  assert.throws(() => compiledTestPath("src/a.ts"), /Not a source test path/);
});

test("extractTestReferences reads explicit paths, globs and flags-separated lists", () => {
  assert.deepEqual(
    extractTestReferences(
      "node --test --test-concurrency=1 dist/test/a.test.js ./dist/test/b.test.js 'dist/test/*.test.js'",
    ),
    ["dist/test/a.test.js", "dist/test/b.test.js", "dist/test/*.test.js"],
  );
  assert.deepEqual(extractTestReferences(undefined), []);
  assert.deepEqual(extractTestReferences("tsc -p tsconfig.json"), []);
});

test("auditTestScript flags a source test the explicit list forgets", () => {
  const result = auditTestScript({
    script: "node --test dist/test/a.test.js dist/test/b.test.js",
    sourceTests: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
  });
  assert.deepEqual(result, { unlisted: ["test/c.test.ts"], missing: [] });
});

test("auditTestScript flags an explicit reference whose source was deleted", () => {
  const result = auditTestScript({
    script: "node --test dist/test/a.test.js dist/test/gone.test.js",
    sourceTests: ["test/a.test.ts"],
  });
  assert.deepEqual(result, { unlisted: [], missing: ["dist/test/gone.test.js"] });
});

test("a single-star glob covers top-level tests but not nested ones", () => {
  const result = auditTestScript({
    script: "node --test dist/test/*.test.js",
    sourceTests: ["test/a.test.ts", "test/nested/b.test.ts"],
  });
  assert.deepEqual(result.unlisted, ["test/nested/b.test.ts"]);
  const recursive = auditTestScript({
    script: "node --test dist/test/**/*.test.js",
    sourceTests: ["test/a.test.ts", "test/nested/b.test.ts"],
  });
  assert.deepEqual(recursive.unlisted, []);
});

test("a package with tests but no test script reports every test as unlisted", () => {
  const result = auditTestScript({ script: undefined, sourceTests: ["test/a.test.ts"] });
  assert.deepEqual(result.unlisted, ["test/a.test.ts"]);
});

test("glob characters in file names are matched literally outside wildcards", () => {
  const result = auditTestScript({
    script: "node --test dist/test/a.b.test.js",
    sourceTests: ["test/a.b.test.ts", "test/aXb.test.ts"],
  });
  assert.deepEqual(result.unlisted, ["test/aXb.test.ts"]);
});

test("auditWorkspace scans pnpm workspace packages on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-test-scripts-"));
  try {
    await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
    const write = async (path, content) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    };
    await write(
      "packages/good/package.json",
      JSON.stringify({ name: "@x/good", scripts: { test: "node --test dist/test/*.test.js" } }),
    );
    await write("packages/good/test/one.test.ts", "");
    await write(
      "packages/bad/package.json",
      JSON.stringify({ name: "@x/bad", scripts: { test: "node --test dist/test/one.test.js dist/test/old.test.js" } }),
    );
    await write("packages/bad/test/one.test.ts", "");
    await write("packages/bad/test/two.test.ts", "");
    await write("packages/bad/test/helpers.ts", "");
    await write("apps/no-tests/package.json", JSON.stringify({ name: "@x/no-tests", scripts: { build: "tsc" } }));
    await mkdir(join(root, "packages/not-a-package"), { recursive: true });

    assert.deepEqual(await auditWorkspace(root), [
      {
        packageName: "@x/bad",
        packageDir: "packages/bad",
        unlisted: ["test/two.test.ts"],
        missing: ["dist/test/old.test.js"],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Kinetra workspace itself runs every test file", async () => {
  assert.deepEqual(await auditWorkspace(process.cwd()), []);
});
