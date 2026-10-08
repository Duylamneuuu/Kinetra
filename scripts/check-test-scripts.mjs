// Guards against test files that exist but are never executed.
//
// Every workspace package lists the compiled test files its `test` script runs
// (`node --test dist/test/a.test.js dist/test/b.test.js ...`) or uses a glob
// (`dist/test/*.test.js`). When a new `test/*.test.ts` is added but not listed,
// `pnpm test` (and CI) silently skips it. This check fails in that case, and
// also when a script lists a test file whose source no longer exists.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const COMPILED_TEST_TOKEN = /(?:^|\s|["'])((?:\.\/)?dist\/test\/[^\s"']+\.test\.js)/g;

/** Maps a package-relative source test path (test/x.test.ts) to its compiled path. */
export function compiledTestPath(sourcePath) {
  const normalized = sourcePath.split(sep).join("/");
  if (!/^test\/.+\.test\.ts$/.test(normalized)) {
    throw new Error(`Not a source test path: ${sourcePath}`);
  }
  return `dist/${normalized.replace(/\.ts$/, ".js")}`;
}

/** Extracts the compiled test file references (explicit paths or globs) from a script. */
export function extractTestReferences(script) {
  const references = [];
  if (typeof script !== "string") return references;
  for (const match of script.matchAll(COMPILED_TEST_TOKEN)) {
    references.push(match[1].replace(/^\.\//, ""));
  }
  return references;
}

function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Pure comparison of a package's `test` script against its source test files.
 * Returns the source tests the script never runs and the explicit script
 * references whose source test does not exist.
 */
export function auditTestScript({ script, sourceTests }) {
  const references = extractTestReferences(script);
  const globs = references.filter((reference) => /[*?]/.test(reference)).map(globToRegExp);
  const explicit = new Set(references.filter((reference) => !/[*?]/.test(reference)));
  const compiled = new Map(sourceTests.map((source) => [compiledTestPath(source), source]));

  const unlisted = [];
  for (const [compiledPath, source] of compiled) {
    if (explicit.has(compiledPath)) continue;
    if (globs.some((glob) => glob.test(compiledPath))) continue;
    unlisted.push(source);
  }
  const missing = [...explicit].filter((reference) => !compiled.has(reference));
  return { unlisted: unlisted.sort(), missing: missing.sort() };
}

async function listSourceTests(packageDir) {
  const testDir = join(packageDir, "test");
  let entries;
  try {
    entries = await readdir(testDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => relative(packageDir, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/"))
    .sort();
}

async function workspacePackageDirs(root) {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const patterns = [...workspace.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm)].map((match) => match[1]);
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
      throw new Error(`Unsupported pnpm workspace pattern: ${pattern}`);
    }
    const parent = join(root, pattern.slice(0, -2));
    let entries = [];
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(parent, entry.name));
    }
  }
  return dirs.sort();
}

/** Audits every workspace package under `root`; returns one entry per problem package. */
export async function auditWorkspace(root) {
  const problems = [];
  for (const packageDir of await workspacePackageDirs(root)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    const sourceTests = await listSourceTests(packageDir);
    const script = manifest.scripts?.test;
    if (sourceTests.length === 0 && !script) continue;
    const { unlisted, missing } = auditTestScript({ script, sourceTests });
    if (unlisted.length > 0 || missing.length > 0) {
      problems.push({
        packageName: manifest.name ?? relative(root, packageDir),
        packageDir: relative(root, packageDir).split(sep).join("/"),
        unlisted,
        missing,
      });
    }
  }
  return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const problems = await auditWorkspace(process.cwd());
  if (problems.length > 0) {
    for (const problem of problems) {
      for (const source of problem.unlisted) {
        console.error(`${problem.packageName}: ${problem.packageDir}/${source} is never run by the package "test" script.`);
      }
      for (const reference of problem.missing) {
        console.error(`${problem.packageName}: "test" script runs ${reference}, but its source test does not exist.`);
      }
    }
    process.exitCode = 1;
  } else {
    console.log("Kinetra test script checks passed: every test file is executed.");
  }
}
