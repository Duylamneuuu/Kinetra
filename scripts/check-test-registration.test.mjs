import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkWorkspace, findUnregisteredTests } from "./check-test-registration.mjs";

test("glob test scripts register every file", () => {
  assert.deepEqual(findUnregisteredTests("node --test dist/test/*.test.js", ["a.test.ts", "b.test.ts"]), []);
});

test("explicit lists report files that are not listed, sorted", () => {
  const script = "node --test --test-concurrency=1 dist/test/a.test.js dist/test/c.test.js";
  assert.deepEqual(findUnregisteredTests(script, ["c.test.ts", "z.test.ts", "a.test.ts", "b.test.ts"]), [
    "b.test",
    "z.test",
  ]);
});

test("names are matched exactly, not by prefix", () => {
  assert.deepEqual(findUnregisteredTests("node --test dist/test/real-ik.test.js", ["real-ik-bridge.test.ts"]), [
    "real-ik-bridge.test",
  ]);
});

test("non-test helpers in test/ are ignored", () => {
  assert.deepEqual(findUnregisteredTests("node --test dist/test/a.test.js", ["a.test.ts", "fixtures.ts"]), []);
});

test("checkWorkspace scans apps, packages and examples", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-test-registration-"));
  try {
    const add = async (dir, script, files) => {
      await mkdir(join(root, dir, "test"), { recursive: true });
      await writeFile(join(root, dir, "package.json"), JSON.stringify({ name: dir, scripts: script ? { test: script } : {} }));
      for (const file of files) await writeFile(join(root, dir, "test", file), "");
    };
    await add("packages/ok", "node --test dist/test/*.test.js", ["x.test.ts"]);
    await add("packages/bad", "node --test dist/test/x.test.js", ["x.test.ts", "y.test.ts"]);
    await add("examples/noscript", undefined, ["w.test.ts"]);
    await mkdir(join(root, "apps", "no-manifest"), { recursive: true });
    const problems = await checkWorkspace(root);
    assert.deepEqual(
      problems.sort((a, b) => a.package.localeCompare(b.package, "en")),
      [
        { package: "examples/noscript", missing: ["w.test"] },
        { package: "packages/bad", missing: ["y.test"] },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
