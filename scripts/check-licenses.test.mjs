import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createLicenseClassifier } from "./license-policy.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..");

const policy = {
  version: 1,
  allowed: ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "Apache-2.0 WITH LLVM-exception"],
  allowedWithNotice: ["CC-BY-4.0"],
  referenceOnly: ["GPL-3.0", "AGPL-3.0-only"],
};

const { classify, splitExpression } = createLicenseClassifier(policy);

test("a single allowed license passes without a notice", () => {
  assert.deepEqual(classify("MIT"), { ok: true, reason: "allowed", tokens: ["MIT"], notice: false });
});

test("notice licenses pass and flag the notice", () => {
  const result = classify("CC-BY-4.0");
  assert.equal(result.ok, true);
  assert.equal(result.notice, true);
});

test("reference-only licenses fail with their own reason", () => {
  assert.deepEqual(classify("GPL-3.0"), {
    ok: false,
    reason: "reference-only",
    tokens: ["GPL-3.0"],
    notice: false,
  });
});

test("unknown licenses are unreviewed, never silently allowed", () => {
  for (const license of ["Unlicense", "SEE LICENSE IN LICENSE.txt", "UNLICENSED", "MIT-0", "mit"]) {
    const result = classify(license);
    assert.equal(result.ok, false, license);
    assert.equal(result.reason, "unreviewed", license);
  }
});

test("compound expressions split on OR/AND (any case) and ignore parentheses", () => {
  assert.deepEqual(splitExpression("(MIT OR Apache-2.0)"), ["MIT", "Apache-2.0"]);
  assert.deepEqual(splitExpression("MIT and ISC"), ["MIT", "ISC"]);
  assert.deepEqual(splitExpression("(MIT AND (ISC OR BSD-3-Clause))"), ["MIT", "ISC", "BSD-3-Clause"]);
  assert.equal(classify("(MIT OR Apache-2.0)").ok, true);
  assert.equal(classify("MIT AND ISC").ok, true);
});

test("every token must be reviewed: one unreviewed token fails the whole expression", () => {
  const result = classify("MIT OR Unlicense");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreviewed");
});

test("a reference-only token fails the package even when another choice is allowed (conservative OR)", () => {
  const result = classify("MIT OR GPL-3.0");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reference-only");
});

test("a notice token anywhere in an otherwise allowed expression marks the notice", () => {
  const result = classify("MIT AND CC-BY-4.0");
  assert.equal(result.ok, true);
  assert.equal(result.notice, true);
});

test("WITH exceptions are accepted only when the exact expression is listed", () => {
  assert.equal(classify("Apache-2.0 WITH LLVM-exception").ok, true);
  assert.deepEqual(splitExpression("Apache-2.0 WITH LLVM-exception"), ["Apache-2.0 WITH LLVM-exception"]);
  const unlisted = classify("MIT WITH Classpath-exception-2.0");
  assert.equal(unlisted.ok, false);
  assert.equal(unlisted.reason, "unreviewed");
  // A compound expression containing WITH is not decomposed, so it cannot sneak a token through.
  assert.equal(classify("MIT OR Apache-2.0 WITH LLVM-exception").ok, false);
});

test("empty and whitespace-only expressions are never allowed", () => {
  for (const license of ["", "   ", "()", "OR"]) {
    const result = classify(license);
    assert.equal(result.ok, false, JSON.stringify(license));
  }
});

test("an empty policy allows nothing and tolerates missing sections", () => {
  const empty = createLicenseClassifier({});
  assert.equal(empty.classify("MIT").ok, false);
  assert.equal(empty.classify("MIT").reason, "unreviewed");
});

test("the repository policy file keeps the invariants the gate relies on", async () => {
  const real = JSON.parse(await readFile(join(repoRoot, ".kinetra", "license-policy.json"), "utf8"));
  const sets = [real.allowed ?? [], real.allowedWithNotice ?? [], real.referenceOnly ?? []];
  const all = sets.flat();
  assert.equal(new Set(all).size, all.length, "a license must appear in exactly one policy list");
  const realClassifier = createLicenseClassifier(real);
  for (const license of real.referenceOnly) {
    assert.equal(realClassifier.classify(license).ok, false, `${license} must stay blocked`);
  }
  for (const license of ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause"]) {
    assert.equal(realClassifier.classify(license).ok, true, `${license} must stay allowed`);
  }
  for (const copyleft of ["GPL-3.0-only", "AGPL-3.0-or-later", "GPL-2.0-only"]) {
    assert.equal(realClassifier.classify(copyleft).ok, false, `${copyleft} must be blocked`);
  }
});

async function makeSandbox(packages) {
  const root = await mkdtemp(join(tmpdir(), "kinetra-licenses-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, ".kinetra"), { recursive: true });
  await copyFile(join(scriptsDir, "check-licenses.mjs"), join(root, "scripts", "check-licenses.mjs"));
  await copyFile(join(scriptsDir, "license-policy.mjs"), join(root, "scripts", "license-policy.mjs"));
  await writeFile(join(root, ".kinetra", "license-policy.json"), JSON.stringify(policy));
  const store = join(root, "node_modules", ".pnpm");
  await mkdir(store, { recursive: true });
  for (const { dir, name, version, license, extra } of packages) {
    const target = join(store, dir, "node_modules", ...name.split("/"));
    await mkdir(target, { recursive: true });
    const manifest = { name, version, ...(license === undefined ? {} : { license }), ...(extra ?? {}) };
    await writeFile(join(target, "package.json"), JSON.stringify(manifest));
  }
  return { root, store };
}

function runGate(root) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "check-licenses.mjs")], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("gate passes on allowed licenses, reports notices and counts installed package roots", async () => {
  const { root } = await makeSandbox([
    { dir: "a@1.0.0", name: "a", version: "1.0.0", license: "MIT" },
    { dir: "@scope+b@2.0.0", name: "@scope/b", version: "2.0.0", license: " Apache-2.0 " },
    { dir: "c@3.0.0", name: "c", version: "3.0.0", license: "CC-BY-4.0" },
  ]);
  try {
    const result = runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /requiring attribution\/notice review/);
    assert.match(result.stdout, /- c@3\.0\.0: CC-BY-4\.0/);
    assert.match(result.stdout, /passed for 3 installed package roots/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate fails with a per-package report for reference-only, unreviewed and missing licenses", async () => {
  const { root } = await makeSandbox([
    { dir: "ok@1.0.0", name: "ok", version: "1.0.0", license: "MIT" },
    { dir: "gpl@1.0.0", name: "gpl", version: "1.0.0", license: "GPL-3.0" },
    { dir: "odd@1.0.0", name: "odd", version: "1.0.0", license: "Unlicense" },
    { dir: "none@1.0.0", name: "none", version: "1.0.0" },
    // Legacy object/array license fields are not trusted either.
    { dir: "legacy@1.0.0", name: "legacy", version: "1.0.0", license: undefined, extra: { licenses: [{ type: "MIT" }] } },
  ]);
  try {
    const result = runGate(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /license policy failed/);
    assert.match(result.stderr, /- gpl@1\.0\.0: GPL-3\.0 \(reference-only\)/);
    assert.match(result.stderr, /- odd@1\.0\.0: Unlicense \(unreviewed\)/);
    assert.match(result.stderr, /- none@1\.0\.0: <missing> \(missing-license\)/);
    assert.match(result.stderr, /- legacy@1\.0\.0: <missing> \(missing-license\)/);
    assert.doesNotMatch(result.stderr, /- ok@1\.0\.0/);
    // Failures are listed in a stable, sorted order.
    const order = ["gpl@1.0.0", "legacy@1.0.0", "none@1.0.0", "odd@1.0.0"].map((name) => result.stderr.indexOf(`- ${name}`));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate ignores nested package.json files that are not an installed package root", async () => {
  const { root, store } = await makeSandbox([{ dir: "host@1.0.0", name: "host", version: "1.0.0", license: "MIT" }]);
  try {
    // A fixture package.json shipped inside a dependency must not be scanned as a dependency itself.
    const nested = join(store, "host@1.0.0", "node_modules", "host", "test", "fixtures");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0", license: "GPL-3.0" }));
    // A manifest whose name does not match its directory is not an installed root either.
    const mismatch = join(store, "host@1.0.0", "node_modules", "other");
    await mkdir(mismatch, { recursive: true });
    await writeFile(join(mismatch, "package.json"), JSON.stringify({ name: "renamed", version: "0.0.0", license: "GPL-3.0" }));
    // Unparseable manifests are skipped instead of crashing the gate.
    const broken = join(store, "host@1.0.0", "node_modules", "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "package.json"), "{ not json");
    const result = runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /passed for 1 installed package roots/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate deduplicates the same name@version installed under several store entries", async () => {
  const { root } = await makeSandbox([
    { dir: "dup@1.0.0_peer-a", name: "dup", version: "1.0.0", license: "ISC" },
    { dir: "dup@1.0.0_peer-b", name: "dup", version: "1.0.0", license: "ISC" },
    { dir: "dup@2.0.0", name: "dup", version: "2.0.0", license: "ISC" },
  ]);
  try {
    const result = runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /passed for 2 installed package roots/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate does not follow symlinks out of the store", async () => {
  const { root, store } = await makeSandbox([{ dir: "ok@1.0.0", name: "ok", version: "1.0.0", license: "MIT" }]);
  try {
    const outside = join(root, "outside", "node_modules", "evil");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "package.json"), JSON.stringify({ name: "evil", version: "1.0.0", license: "GPL-3.0" }));
    await symlink(join(root, "outside"), join(store, "link@1.0.0"), "dir");
    const result = runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /passed for 1 installed package roots/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate explains how to recover when dependencies are not installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kinetra-licenses-empty-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, ".kinetra"), { recursive: true });
    await copyFile(join(scriptsDir, "check-licenses.mjs"), join(root, "scripts", "check-licenses.mjs"));
    await copyFile(join(scriptsDir, "license-policy.mjs"), join(root, "scripts", "license-policy.mjs"));
    await writeFile(join(root, ".kinetra", "license-policy.json"), JSON.stringify(policy));
    const result = runGate(root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Run "pnpm install" first/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
