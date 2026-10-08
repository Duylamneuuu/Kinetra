// Fails when a workspace package has a `test/*.test.ts` file that its `test`
// script never runs. Packages that list test files explicitly (instead of a
// `dist/test/*.test.js` glob) silently skip new files unless someone remembers
// to register them; this check makes that omission a CI failure.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE_GLOBS = ["apps", "packages", "examples"];

/**
 * Pure: returns the test basenames (without extension) that `testScript`
 * does not run. `testFiles` are basenames like `foo.test.ts`.
 */
export function findUnregisteredTests(testScript, testFiles) {
  const tokens = testScript.split(/\s+/).filter(Boolean);
  const globRuns = tokens.some((token) => /(^|\/)dist\/test\/\*\.test\.js$/.test(token));
  if (globRuns) {
    return [];
  }
  const registered = new Set(
    tokens
      .map((token) => token.match(/(?:^|\/)dist\/test\/([^/]+)\.js$/)?.[1])
      .filter((name) => name !== undefined),
  );
  return testFiles
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => file.slice(0, -".ts".length))
    .filter((name) => !registered.has(name))
    .sort();
}

async function listDirs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function listTestFiles(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".test.ts"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function checkWorkspace(root = ".") {
  const problems = [];
  for (const group of WORKSPACE_GLOBS) {
    for (const dir of await listDirs(join(root, group))) {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
      const testScript = manifest.scripts?.test;
      const testFiles = await listTestFiles(join(dir, "test"));
      if (testFiles.length === 0) continue;
      if (typeof testScript !== "string") {
        problems.push({ package: manifest.name ?? dir, missing: testFiles.map((f) => f.slice(0, -3)) });
        continue;
      }
      const missing = findUnregisteredTests(testScript, testFiles);
      if (missing.length > 0) problems.push({ package: manifest.name ?? dir, missing });
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = await checkWorkspace(".");
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.package}: test script does not run ${problem.missing.join(", ")}`);
    }
    console.error("Register these files in the package's `test` script (or switch it to dist/test/*.test.js).");
    process.exit(1);
  }
  console.log("Every test/*.test.ts file is registered in its package test script.");
}
