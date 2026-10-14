import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, type Metafile } from "esbuild";

import { createOrbRunReplays, playOrbRunReplay, type OrbRunReplay } from "../src/index.js";

/**
 * `entry-portability` and `transitive-portability` scan imports with a regex walker. Neither ran a
 * real bundler ("Not proven: a real bundler run", README slices 20 and 24). This test does: esbuild
 * bundles the built entry (and every `@kinetra/*` package behind it) into ONE ES module, we import
 * that module from a temp directory with no `node_modules` around it, and drive the game through it.
 *
 * What it proves:
 *  - the whole engine slice orb-run uses resolves and bundles (no unresolved import, no dynamic
 *    require the bundler cannot see);
 *  - the bundle is self-contained: apart from Node builtins it imports nothing, so it does not
 *    secretly depend on the workspace layout;
 *  - the bundled game is the same game: it records byte-identical replays to the unbundled one,
 *    and plays the committed golden replays to the same digests.
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/test -> package root
const packageRoot = resolve(here, "..", "..");
const entry = resolve(packageRoot, "dist", "src", "index.js");

interface BundledGame {
  createOrbRunReplays: () => Promise<{ win: OrbRunReplay; timeout: OrbRunReplay }>;
  playOrbRunReplay: (replay: unknown) => Promise<{ verified: boolean; finalDigest: string; summary: { status: string; collectedCount: number } }>;
}

let scratch = "";
let metafile: Metafile;
let bundleText = "";
let bundled: BundledGame;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "orb-run-bundle-"));
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node", // Node builtins stay external; everything else must be bundled in
    target: "node22",
    logLevel: "silent",
    outfile: join(scratch, "orb-run.bundle.mjs"),
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  metafile = result.metafile;
  const output = result.outputFiles?.[0];
  assert.ok(output, "esbuild produced an output file");
  bundleText = output.text;
  const file = join(scratch, "orb-run.bundle.mjs");
  await writeFile(file, bundleText, "utf8");
  bundled = (await import(pathToFileURL(file).href)) as BundledGame;
});

after(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
});

test("the entry and the engine packages behind it bundle into one self-contained module", () => {
  const inputs = Object.keys(metafile.inputs);
  for (const marker of [
    "packages/core/", "packages/command-bus/", "packages/project-model/", "packages/animation/",
    "packages/asset-pipeline/", "packages/audio/", "dist/src/game.js", "dist/src/replay.js",
  ]) {
    assert.ok(inputs.some((input) => input.includes(marker)), `${marker} is part of the bundle`);
  }
  // Test-harness and tooling packages are type-only at run time: the real bundle must not carry them
  // (the source-graph ledger of slice 24 counts `@kinetra/verification` because tsc still sees its types).
  for (const marker of ["packages/verification/", "packages/mcp-server/", "packages/navigation-recast/", "packages/input/", "@modelcontextprotocol", "recast"]) {
    assert.ok(!inputs.some((input) => input.includes(marker)), `${marker} must not be bundled with the game`);
  }
  const [outputPath] = Object.keys(metafile.outputs);
  assert.ok(outputPath, "a single output");
  assert.equal(Object.keys(metafile.outputs).length, 1, "one file, no code splitting");
  const imports = metafile.outputs[outputPath]!.imports;
  const nonBuiltin = imports.filter((entryImport) => !entryImport.path.startsWith("node:")).map((entryImport) => entryImport.path);
  assert.deepEqual(nonBuiltin, [], "after bundling, nothing but Node builtins is imported at run time");
  assert.ok(!/from\s*["']@kinetra\//.test(bundleText), "no workspace package specifier survives in the bundle");
});

test("the Node builtins the bundle still needs stay inside the measured allow-list", () => {
  const [outputPath] = Object.keys(metafile.outputs);
  const builtins = [...new Set(metafile.outputs[outputPath!]!.imports.map((entryImport) => entryImport.path))].sort();
  // Measured on the real bundle, tighter than the slice 24 ledger (which also counts the types-only
  // `@kinetra/verification`): only the asset pipeline and animation loaders reach the file system.
  // A new builtin fails here; paying the debt down only loosens the bound.
  const allowed = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:path"]);
  const extra = builtins.filter((name) => !allowed.has(name));
  assert.deepEqual(extra, [], `new Node builtins in the real bundle: ${extra.join(", ")}`);
});

test("the bundled game records byte-identical replays to the unbundled game", async () => {
  const fromSource = await createOrbRunReplays();
  const fromBundle = await bundled.createOrbRunReplays();
  assert.equal(JSON.stringify(fromBundle.win), JSON.stringify(fromSource.win));
  assert.equal(JSON.stringify(fromBundle.timeout), JSON.stringify(fromSource.timeout));
  assert.equal(fromBundle.win.outcome.status, "won");
});

test("the bundled game plays the committed golden replays to the same digests", async () => {
  for (const name of ["win", "timeout"] as const) {
    const url = new URL(`../../acceptance/replays/${name}.replay.json`, import.meta.url);
    const committed = JSON.parse(await readFile(url, "utf8")) as OrbRunReplay;
    const viaBundle = await bundled.playOrbRunReplay(committed);
    const viaSource = await playOrbRunReplay(committed);
    assert.equal(viaBundle.verified, true, `${name}.replay.json verifies through the bundle`);
    assert.equal(viaBundle.finalDigest, viaSource.finalDigest);
    assert.equal(viaBundle.summary.status, viaSource.summary.status);
    assert.equal(viaBundle.summary.collectedCount, viaSource.summary.collectedCount);
  }
});

test("a tampered replay is still caught by the bundled game (the bundle is not a stub)", async () => {
  const { win } = await bundled.createOrbRunReplays();
  const tampered = JSON.parse(JSON.stringify(win)) as OrbRunReplay;
  tampered.inputs.shift();
  const result = await bundled.playOrbRunReplay(tampered);
  assert.equal(result.verified, false);
});
