import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * End-to-end tests for the two tiny CLI gates `pnpm check` runs first and
 * after build: scripts/check-foundation.mjs (required docs exist, JSON parses)
 * and scripts/check-bundle-size.mjs (player bundle budget). Both are executed
 * as real child processes inside a throwaway directory so a regression in
 * their exit code or message is caught, not just in the pure helpers.
 */

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function run(script, cwd) {
  return spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
}

const REQUIRED_FOUNDATION_FILES = [
  "README.md",
  "VISION.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "ROADMAP.md",
  "LICENSE-POLICY.md",
  "docs/principles/AI_FIRST.md",
  "docs/architecture/COMMAND_API.md",
  "docs/architecture/ASSET_PIPELINE.md",
  "docs/architecture/VERIFICATION.md",
  "agents/engine-guide/three.md",
];

async function writeFoundation(root, { skip } = {}) {
  for (const path of REQUIRED_FOUNDATION_FILES) {
    if (path === skip) continue;
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "# stub\n");
  }
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "tsconfig.base.json"), "{}\n");
}

describe("check-foundation.mjs", () => {
  const script = join(scriptsDir, "check-foundation.mjs");

  it("passes when every required document and both JSON files are present", async () => {
    const root = await tempDir("kinetra-foundation-ok-");
    await writeFoundation(root);
    const result = run(script, root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /foundation checks passed/);
  });

  it("fails and names the file when a required document is missing", async () => {
    for (const missing of REQUIRED_FOUNDATION_FILES) {
      const root = await tempDir("kinetra-foundation-missing-");
      await writeFoundation(root, { skip: missing });
      const result = run(script, root);
      assert.notEqual(result.status, 0, `${missing} missing should fail`);
      assert.match(result.stderr, /ENOENT/);
      assert.ok(
        result.stderr.replace(/\\+/g, "/").includes(missing),
        `stderr should name ${missing}: ${result.stderr}`,
      );
      assert.doesNotMatch(result.stdout, /passed/);
    }
  });

  it("fails when package.json or tsconfig.base.json is not valid JSON", async () => {
    for (const broken of ["package.json", "tsconfig.base.json"]) {
      const root = await tempDir("kinetra-foundation-json-");
      await writeFoundation(root);
      await writeFile(join(root, broken), "{ not json");
      const result = run(script, root);
      assert.notEqual(result.status, 0, `${broken} invalid should fail`);
      assert.match(result.stderr, /SyntaxError|JSON/);
      assert.doesNotMatch(result.stdout, /passed/);
    }
  });

  it("fails when package.json is missing entirely", async () => {
    const root = await tempDir("kinetra-foundation-nopkg-");
    await writeFoundation(root);
    await rm(join(root, "package.json"));
    const result = run(script, root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
  });
});

/** A sandbox repo layout so check-bundle-size.mjs resolves ../ against it. */
async function bundleSandbox({ config, files, html }) {
  const root = await tempDir("kinetra-bundle-");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, ".kinetra"), { recursive: true });
  await copyFile(join(scriptsDir, "check-bundle-size.mjs"), join(root, "scripts", "check-bundle-size.mjs"));
  await copyFile(join(scriptsDir, "bundle-budget.mjs"), join(root, "scripts", "bundle-budget.mjs"));
  if (config !== undefined) {
    await writeFile(join(root, ".kinetra", "bundle-budget.json"), JSON.stringify(config));
  }
  if (files !== undefined) {
    const assets = join(root, "dist", "assets");
    await mkdir(assets, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(assets, name), contents);
    }
  }
  if (html !== undefined) {
    await writeFile(join(root, "dist", "index.html"), html);
  }
  return join(root, "scripts", "check-bundle-size.mjs");
}

const noise = (length, seed) => {
  // Deterministic, hard-to-compress text: chained SHA-256 digests as base64.
  let out = "";
  let digest = createHash("sha256").update(String(seed)).digest();
  while (out.length < length) {
    out += digest.toString("base64");
    digest = createHash("sha256").update(digest).digest();
  }
  return out.slice(0, length);
};

describe("check-bundle-size.mjs", () => {
  const files = { "index-a.js": noise(4000, 1), "lazy-b.js": noise(6000, 2), "index-a.js.map": "{}" };
  const html = '<script type="module" src="/assets/index-a.js"></script>';

  it("passes within budget and reports every chunk, ignoring source maps", async () => {
    const script = await bundleSandbox({
      config: {
        assetsDir: "dist/assets",
        entryHtml: "dist/index.html",
        budgets: {
          totalJsRawBytes: 20000,
          totalJsGzipBytes: 20000,
          largestJsGzipBytes: 20000,
          initialJsGzipBytes: 20000,
        },
      },
      files,
      html,
    });
    const result = run(script, dirname(script));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /index-a\.js:/);
    assert.match(result.stdout, /lazy-b\.js:/);
    assert.doesNotMatch(result.stdout, /\.map/);
    assert.match(result.stdout, /totalJsRawBytes: 9\.8 KiB/);
    assert.match(result.stdout, /bundle budget passed/);
  });

  it("exits 1 and lists the violated metric when a budget is exceeded", async () => {
    const script = await bundleSandbox({
      config: {
        assetsDir: "dist/assets",
        budgets: { totalJsRawBytes: 9000, largestJsGzipBytes: 1000000 },
      },
      files,
    });
    const result = run(script, dirname(script));
    assert.equal(result.status, 1);
    const violations = JSON.parse(result.stderr.slice(0, result.stderr.lastIndexOf("}") + 1)).violations;
    assert.deepEqual(
      violations.map((v) => [v.code, v.metric, v.actual, v.budget]),
      [["bundle.budgetExceeded", "totalJsRawBytes", 10000, 9000]],
    );
    assert.match(result.stderr, /Bundle budget exceeded/);
    assert.doesNotMatch(result.stdout, /budget passed/);
  });

  it("counts only eagerly loaded chunks toward initialJsGzipBytes", async () => {
    // A budget above the eager chunk but below eager + lazy must pass only
    // because lazy-b.js is not on the startup path.
    const eager = gzipSync(files["index-a.js"], { level: 9 }).length;
    const both = eager + gzipSync(files["lazy-b.js"], { level: 9 }).length;
    const budget = Math.floor((eager + both) / 2);
    assert.ok(eager < budget && budget < both);
    const script = await bundleSandbox({
      config: {
        assetsDir: "dist/assets",
        entryHtml: "dist/index.html",
        budgets: { initialJsGzipBytes: budget },
      },
      files,
      html,
    });
    const result = run(script, dirname(script));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /initialJsGzipBytes:/);

    const tight = await bundleSandbox({
      config: {
        assetsDir: "dist/assets",
        entryHtml: "dist/index.html",
        budgets: { initialJsGzipBytes: eager - 1 },
      },
      files,
      html,
    });
    const tightResult = run(tight, dirname(tight));
    assert.equal(tightResult.status, 1);
    assert.match(tightResult.stderr, /initialJsGzipBytes/);
  });

  it("fails loudly when the entry HTML references a chunk that was not built", async () => {
    const script = await bundleSandbox({
      config: {
        assetsDir: "dist/assets",
        entryHtml: "dist/index.html",
        budgets: { initialJsGzipBytes: 20000 },
      },
      files,
      html: '<script type="module" src="/assets/index-missing.js"></script>',
    });
    const result = run(script, dirname(script));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in the bundle/);
  });

  it("fails loudly when the assets directory is missing or has no JavaScript", async () => {
    const missing = await bundleSandbox({
      config: { assetsDir: "dist/assets", budgets: { totalJsRawBytes: 1000 } },
    });
    const missingResult = run(missing, dirname(missing));
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /assets directory not found/);

    const empty = await bundleSandbox({
      config: { assetsDir: "dist/assets", budgets: { totalJsRawBytes: 1000 } },
      files: { "style.css": "body{}" },
    });
    const emptyResult = run(empty, dirname(empty));
    assert.notEqual(emptyResult.status, 0);
    assert.match(emptyResult.stderr, /No JavaScript chunks/);
  });

  it("rejects an unknown or non-positive budget instead of silently passing", async () => {
    for (const budgets of [{ totalJsBytes: 1 }, { totalJsRawBytes: 0 }, { totalJsRawBytes: 1.5 }]) {
      const script = await bundleSandbox({
        config: { assetsDir: "dist/assets", budgets },
        files,
      });
      const result = run(script, dirname(script));
      assert.notEqual(result.status, 0, JSON.stringify(budgets));
      assert.match(result.stderr, /Unknown bundle budget metric|must be a positive integer/);
    }
  });

  it("fails when the budget config itself is missing", async () => {
    const script = await bundleSandbox({ files });
    const result = run(script, dirname(script));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
  });
});
