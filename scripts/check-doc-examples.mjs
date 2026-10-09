#!/usr/bin/env node
// Typechecks AND runs every TypeScript example in the docs that opts in with a
// `doc-check` fence tag, so documentation cannot silently drift from the code.
//
// Opt-in syntax (inside any tracked *.md file):
//
//   ```ts doc-check                 -> package inferred from packages/<pkg>/...
//   ```ts doc-check=mcp-server      -> explicit workspace package (packages/<pkg>)
//
// Each example is written into `packages/<pkg>/.doc-examples/`, compiled with
// that package's own tsconfig (strict, NodeNext) and executed with Node. The
// package's own name resolves through Node's package self-reference, and its
// workspace dependencies resolve through its node_modules, so an example can
// import exactly what a consumer would import (`@kinetra/animation/ik`).
// Examples should assert their claims with `node:assert/strict`.
//
// Requires `pnpm build` first (examples import the built `dist/` output).
// The temp directory is removed afterwards; `--keep` leaves it for debugging.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractExamples } from "./doc-examples.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const tscBin = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".doc-examples", ".pnpm-store", "release", "out"]);

async function* markdownFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* markdownFiles(join(dir, entry.name));
    } else if (entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    }
  }
}

const examples = [];
for await (const file of markdownFiles(root)) {
  examples.push(...extractExamples(file, await readFile(file, "utf8"), root));
}

if (examples.length === 0) {
  console.log("No doc-check examples found.");
  process.exit(0);
}

const byPackage = new Map();
for (const example of examples) {
  const list = byPackage.get(example.pkg) ?? [];
  list.push(example);
  byPackage.set(example.pkg, list);
}

let failures = 0;
for (const [pkg, list] of byPackage) {
  const pkgDir = join(root, "packages", pkg);
  if (!existsSync(join(pkgDir, "tsconfig.json"))) {
    console.error(`doc-check: unknown package "${pkg}" (no packages/${pkg}/tsconfig.json)`);
    failures += list.length;
    continue;
  }
  const work = join(pkgDir, ".doc-examples");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const names = [];
  for (const [index, example] of list.entries()) {
    const name = `example-${String(index + 1).padStart(2, "0")}`;
    names.push(name);
    const banner = `// doc-check: ${relative(root, example.file).split(sep).join("/")}:${example.line}\n`;
    await writeFile(join(work, `${name}.ts`), banner + example.code);
  }
  await writeFile(
    join(work, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../tsconfig.json",
        compilerOptions: { rootDir: ".", outDir: "./out", noEmit: false, declaration: false, declarationMap: false, sourceMap: false, composite: false, incremental: false },
        include: ["*.ts"],
      },
      null,
      2,
    ),
  );

  const compile = spawnSync(process.execPath, [tscBin, "-p", join(work, "tsconfig.json")], { cwd: pkgDir, encoding: "utf8" });
  if (compile.status !== 0) {
    console.error(`doc-check: typecheck failed for ${pkg}:\n${compile.stdout}${compile.stderr}`);
    console.error("  (file banners map example-NN.ts back to the markdown source)");
    for (const [index, example] of list.entries()) {
      console.error(`  example-${String(index + 1).padStart(2, "0")}.ts <- ${relative(root, example.file)}:${example.line}`);
    }
    failures += list.length;
  } else {
    for (const [index, name] of names.entries()) {
      const example = list[index];
      const where = `${relative(root, example.file)}:${example.line}`;
      const run = spawnSync(process.execPath, [join(work, "out", `${name}.js`)], { cwd: pkgDir, encoding: "utf8", timeout: 60_000 });
      if (run.status !== 0) {
        failures++;
        console.error(`doc-check: FAIL ${where} (${pkg})\n${run.stdout}${run.stderr}${run.error ? String(run.error) : ""}`);
      } else {
        console.log(`doc-check: ok   ${where} (${pkg})`);
      }
    }
  }
  if (!keep) await rm(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`doc-check: ${failures} of ${examples.length} example(s) failed.`);
  process.exit(1);
}
console.log(`doc-check: ${examples.length} example(s) typechecked and ran.`);
