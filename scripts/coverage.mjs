// Unit-test coverage report for the Kinetra workspace (no extra dependencies).
//
// For every workspace package with a `test` script, runs the compiled test files
// that script lists through `node --test --experimental-test-coverage` with the
// built-in lcov reporter, then summarizes line / branch / function coverage of
// that package's own compiled sources (`dist/` minus `dist/test/`).
//
//   pnpm build && pnpm coverage                     # all packages, unit tests only
//   pnpm coverage -- --package @kinetra/animation   # one package
//   pnpm coverage -- --include-real                 # also real-Electron tests (needs a display / xvfb)
//
// Writes coverage/<package>.lcov, coverage/summary.json and coverage/summary.md.
// Report-only: it never fails on a threshold (see issue #107).

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const COMPILED_TEST_TOKEN = /(?:^|\s|["'])((?:\.\/)?dist\/test\/[^\s"']+\.test\.js)/g;

/** Extracts the compiled test file references (explicit paths or globs) from a `test` script. */
export function extractTestReferences(script) {
  if (typeof script !== "string") return [];
  return [...script.matchAll(COMPILED_TEST_TOKEN)].map((match) => match[1].replace(/^\.\//, ""));
}

/** Parses lcov text into per-file line/branch/function hit counts. */
export function parseLcov(text) {
  const files = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3), lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } };
    } else if (!current) {
      continue;
    } else if (line === "end_of_record") {
      files.push(current);
      current = null;
    } else {
      const [key, value] = line.split(":", 2);
      const count = Number(value);
      if (!Number.isFinite(count)) continue;
      if (key === "LF") current.lines.found = count;
      else if (key === "LH") current.lines.hit = count;
      else if (key === "BRF") current.branches.found = count;
      else if (key === "BRH") current.branches.hit = count;
      else if (key === "FNF") current.functions.found = count;
      else if (key === "FNH") current.functions.hit = count;
    }
  }
  return files;
}

/** Percentage with one decimal; a metric with nothing to cover counts as 100%. */
export function percent({ found, hit }) {
  if (found <= 0) return 100;
  return Math.round((Math.min(hit, found) / found) * 1000) / 10;
}

/** Sums the lcov records whose file passes `include` into one coverage total. */
export function summarize(records, include = () => true) {
  const total = { files: 0, lines: { found: 0, hit: 0 }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } };
  for (const record of records) {
    if (!include(record.file)) continue;
    total.files += 1;
    for (const metric of ["lines", "branches", "functions"]) {
      total[metric].found += record[metric].found;
      total[metric].hit += record[metric].hit;
    }
  }
  return {
    files: total.files,
    lines: { ...total.lines, pct: percent(total.lines) },
    branches: { ...total.branches, pct: percent(total.branches) },
    functions: { ...total.functions, pct: percent(total.functions) },
  };
}

/** Renders package summaries as a markdown table. */
export function renderMarkdown(rows) {
  const lines = [
    "| Package | Files | Lines % | Branches % | Functions % |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    if (row.error) {
      lines.push(`| ${row.packageName} | – | – | – | – (${row.error}) |`);
    } else {
      lines.push(
        `| ${row.packageName} | ${row.summary.files} | ${row.summary.lines.pct} | ${row.summary.branches.pct} | ${row.summary.functions.pct} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function globToRegExp(pattern) {
  const source = pattern
    .split("**/")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`);
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/"));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Resolves a package's test script references to existing compiled test files. */
export async function resolveTestFiles(packageDir, script) {
  const compiled = (await listFiles(join(packageDir, "dist/test"))).map((file) => `dist/test/${file}`);
  const selected = new Set();
  for (const reference of extractTestReferences(script)) {
    if (/[*?]/.test(reference)) {
      const pattern = globToRegExp(reference);
      for (const file of compiled) if (pattern.test(file)) selected.add(file);
    } else if (compiled.includes(reference)) {
      selected.add(reference);
    }
  }
  return [...selected].sort();
}

/**
 * True for the package's own compiled sources: anything under `dist/` except
 * `dist/test/` (most packages emit `dist/src/`, examples may emit `dist/*.js`).
 * Dependencies (other workspace packages, node_modules) are excluded.
 */
export function isPackageSourceFile(packageDir, file) {
  const absolute = resolve(packageDir, file);
  const dist = join(resolve(packageDir), "dist") + sep;
  const distTest = join(dist, "test") + sep;
  return absolute.startsWith(dist) && !absolute.startsWith(distTest) && !absolute.includes(`${sep}node_modules${sep}`);
}

/** Real-Electron acceptance tests need a display; skipped unless --include-real. */
export function isRealElectronTest(file) {
  return /(^|\/)real-[^/]*\.test\.js$/.test(file);
}

async function workspacePackageDirs(root) {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const patterns = [...workspace.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm)].map((match) => match[1]);
  const dirs = [];
  for (const pattern of patterns) {
    const parent = join(root, pattern.replace(/\/\*$/, ""));
    let entries = [];
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) if (entry.isDirectory()) dirs.push(join(parent, entry.name));
  }
  return dirs.sort();
}

function parseArgs(argv) {
  const options = { packages: [], includeReal: false, outDir: "coverage" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--include-real") options.includeReal = true;
    else if (arg === "--package") options.packages.push(argv[++index]);
    else if (arg === "--out") options.outDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const root = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(root, options.outDir);
  await mkdir(outDir, { recursive: true });
  const rows = [];

  for (const packageDir of await workspacePackageDirs(root)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    const script = manifest.scripts?.test;
    const packageName = manifest.name ?? relative(root, packageDir);
    if (!script) continue;
    if (options.packages.length > 0 && !options.packages.includes(packageName)) continue;

    const testFiles = (await resolveTestFiles(packageDir, script)).filter(
      (file) => options.includeReal || !isRealElectronTest(file),
    );
    if (testFiles.length === 0) {
      rows.push({ packageName, error: "no runnable unit tests (build first?)" });
      continue;
    }

    const lcovPath = join(outDir, `${packageName.replace(/[@/]/g, (char) => (char === "@" ? "" : "__"))}.lcov`);
    await rm(lcovPath, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--experimental-test-coverage",
        "--test-concurrency=1",
        "--test-reporter=dot",
        "--test-reporter-destination=stdout",
        "--test-reporter=lcov",
        `--test-reporter-destination=${lcovPath}`,
        ...testFiles,
      ],
      { cwd: packageDir, stdio: ["ignore", "inherit", "inherit"] },
    );
    let records = [];
    try {
      records = parseLcov(await readFile(lcovPath, "utf8"));
    } catch {
      records = [];
    }
    const summary = summarize(records, (file) => isPackageSourceFile(packageDir, file));
    rows.push(
      result.status === 0
        ? { packageName, testFiles: testFiles.length, summary }
        : { packageName, testFiles: testFiles.length, summary, error: `tests exited with ${result.status}` },
    );
  }

  const markdown = renderMarkdown(rows);
  await writeFile(join(outDir, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
  await writeFile(join(outDir, "summary.md"), markdown);
  console.log(`\nKinetra unit-test coverage (compiled dist sources, report only)\n\n${markdown}`);
  if (rows.some((row) => row.error && row.summary)) process.exitCode = 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await main();
}
