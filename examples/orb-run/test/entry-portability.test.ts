import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/**
 * The package entry (`src/index.ts`) is what a renderer / the Electron player bundle will import
 * (slice 20 prepares for the pluggable game module of #79 / #185). It must stay loadable in a
 * browser-like context: no Node builtins, no Node globals, and none of the Node-only modules
 * (Recast WASM navigation, the acceptance suite / CLI, the snapshot writer, the MCP test client).
 * This test reads the *source* import graph from the entry so the rule is enforced statically.
 */

/**
 * The scanner works on forward-slash paths only (virtual files in the sabotage tests, and real
 * files after `toPosixPath`), so it behaves the same on Windows, where `path.resolve` would turn
 * "/virtual/index.ts" into "C:\virtual\index.ts" and the base-name checks below would never match.
 */
const toPosixPath = (path: string): string => path.replace(/\\/g, "/");

const here = dirname(fileURLToPath(import.meta.url));
// dist/test -> package root
const packageRoot = resolve(here, "..", "..");
const srcDir = resolve(packageRoot, "src");

/** Modules the entry must never reach, with the reason (surfaced in the failure message). */
const NODE_ONLY_MODULES: Readonly<Record<string, string>> = {
  "navigation.ts": "loads Recast WASM (Node-only by design)",
  "acceptance-suite.ts": "reads manifests from disk",
  "acceptance-cli.ts": "process.argv / process.exit",
  "write-snapshot.ts": "writes files",
};

/** External packages the entry may import (everything in package.json dependencies except navigation-recast). */
const ALLOWED_EXTERNAL = new Set([
  "@kinetra/animation",
  "@kinetra/asset-pipeline",
  "@kinetra/audio",
  "@kinetra/command-bus",
  "@kinetra/core",
  "@kinetra/project-model",
  "@kinetra/verification",
]);

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "net", "os", "path",
  "process", "readline", "stream", "url", "util", "vm", "worker_threads", "zlib",
]);

export interface PortabilityFinding {
  readonly file: string;
  readonly code: "node_builtin" | "node_only_module" | "external_not_allowed" | "node_global" | "unresolved";
  readonly detail: string;
}

/** Strip comments and string-free noise cheaply enough for import scanning. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

export const importSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  const text = stripComments(source);
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) out.push(spec);
  }
  return out;
};

const NODE_GLOBAL_RE = /(?<![\w.$#])(?:process\.(?:argv|env|exit|cwd|stdout|stderr|platform)|Buffer\.|__dirname|__filename|require\()/;

export const scanPortability = async (
  entry: string,
  readSource: (file: string) => Promise<string>,
): Promise<{ readonly files: string[]; readonly findings: PortabilityFinding[] }> => {
  const seen = new Set<string>();
  const findings: PortabilityFinding[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (NODE_ONLY_MODULES[base] !== undefined) {
      findings.push({ file, code: "node_only_module", detail: NODE_ONLY_MODULES[base] });
    }
    let source: string;
    try {
      source = await readSource(file);
    } catch {
      findings.push({ file, code: "unresolved", detail: "source file could not be read" });
      continue;
    }
    const globalUse = NODE_GLOBAL_RE.exec(stripComments(source));
    if (globalUse) {
      findings.push({ file, code: "node_global", detail: `uses a Node-only global: ${globalUse[0]}` });
    }
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith(".")) {
        queue.push(posix.normalize(posix.join(posix.dirname(file), spec.replace(/\.js$/, ".ts"))));
      } else if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? "")) {
        findings.push({ file, code: "node_builtin", detail: spec });
      } else {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);
        if (!ALLOWED_EXTERNAL.has(pkg)) {
          findings.push({ file, code: "external_not_allowed", detail: spec });
        }
      }
    }
  }
  return { files: [...seen].sort(), findings };
};

const readDisk = (file: string): Promise<string> => readFile(file, "utf8");

test("the package entry's import graph is free of Node builtins, Node globals and Node-only modules", async () => {
  const { files, findings } = await scanPortability(toPosixPath(resolve(srcDir, "index.ts")), readDisk);
  assert.deepEqual(findings, [], `entry is not portable:\n${JSON.stringify(findings, null, 2)}`);
  // The walk really covered the game, not just the barrel file.
  const names = files.map((file) => file.slice(file.lastIndexOf("/") + 1));
  for (const expected of ["authoring.ts", "scripts.ts", "simulation.ts", "acceptance-probe.ts", "hud.ts", "fuzz.ts", "sha256.ts"]) {
    assert.ok(names.includes(expected), `${expected} is reachable from the entry`);
  }
  assert.ok(files.length >= 20, `walked ${files.length} files`);
});

test("the Node-only modules exist and are the ones the README says are kept out of the entry", async () => {
  for (const name of Object.keys(NODE_ONLY_MODULES)) {
    const text = await readDisk(resolve(srcDir, name));
    assert.ok(text.length > 0, name);
  }
  const index = await readDisk(resolve(srcDir, "index.ts"));
  for (const name of Object.keys(NODE_ONLY_MODULES)) {
    assert.ok(!index.includes(`./${name.replace(/\.ts$/, ".js")}`), `${name} is not exported from the entry`);
  }
});

test("importSpecifiers finds static, re-export, type, side-effect and dynamic imports and ignores comments", () => {
  const specs = importSpecifiers(`
    import a from "./a.js";
    import type { B } from "./b.js";
    import { c,
      d } from "@kinetra/core";
    export * from "./e.js";
    export { f } from "./f.js";
    import "./side.js";
    const g = await import("./g.js");
    // import x from "./commented.js";
    /* import y from "./block.js"; */
  `);
  assert.deepEqual(specs.sort(), ["./a.js", "./b.js", "./e.js", "./f.js", "./g.js", "./side.js", "@kinetra/core"]);
});

test("the scanner fires on sabotaged sources (builtin, Node-only module, forbidden package, Node global, missing file)", async () => {
  const entry = "/virtual/index.ts";
  const files: Record<string, string> = {
    "/virtual/index.ts": `export * from "./ok.js";\nexport * from "./bad.js";\nexport * from "./navigation.js";\nexport * from "./gone.js";`,
    "/virtual/ok.ts": `import { x } from "@kinetra/core";\nexport const ok = x;`,
    "/virtual/bad.ts": `import { readFile } from "node:fs/promises";\nimport p from "path";\nimport w from "@kinetra/navigation-recast";\nexport const t = process.argv;`,
    "/virtual/navigation.ts": `export const nav = 1;`,
  };
  const { findings } = await scanPortability(entry, async (file) => {
    const text = files[file];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  });
  const summary = findings.map((finding) => `${finding.code}:${finding.file.slice(finding.file.lastIndexOf("/") + 1)}:${finding.detail}`).sort();
  assert.deepEqual(summary, [
    "external_not_allowed:bad.ts:@kinetra/navigation-recast",
    "node_builtin:bad.ts:node:fs/promises",
    "node_builtin:bad.ts:path",
    "node_global:bad.ts:uses a Node-only global: process.argv",
    "node_only_module:navigation.ts:loads Recast WASM (Node-only by design)",
    "unresolved:gone.ts:source file could not be read",
  ]);
});

/**
 * #420: the renderer-facing entries of the three packages that used to import `node:*` from their
 * barrels. The walk is the same as the game entry's, with each package's own external allow-list.
 */
const ENGINE_PURE_ENTRIES: ReadonlyArray<{ name: string; entry: string; allowed: readonly string[] }> = [
  {
    name: "@kinetra/asset-pipeline/pure",
    entry: toPosixPath(resolve(packageRoot, "..", "..", "packages", "asset-pipeline", "src", "pure.ts")),
    allowed: ["@gltf-transform/core"],
  },
  {
    name: "@kinetra/animation/contracts",
    entry: toPosixPath(resolve(packageRoot, "..", "..", "packages", "animation", "src", "contracts.ts")),
    allowed: ["@gltf-transform/core", "three"],
  },
  {
    name: "@kinetra/verification/browser",
    entry: toPosixPath(resolve(packageRoot, "..", "..", "packages", "verification", "src", "browser.ts")),
    allowed: ["@kinetra/project-model", "pngjs", "zod"],
  },
];

async function scanEngineEntry(
  entry: string,
  allowed: ReadonlySet<string>,
): Promise<PortabilityFinding[]> {
  const seen = new Set<string>();
  const findings: PortabilityFinding[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = await readDisk(file);
    } catch {
      findings.push({ file, code: "unresolved", detail: "source file could not be read" });
      continue;
    }
    const globalUse = NODE_GLOBAL_RE.exec(stripComments(source));
    if (globalUse) {
      findings.push({ file, code: "node_global", detail: `uses a Node-only global: ${globalUse[0]}` });
    }
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith(".")) {
        queue.push(posix.normalize(posix.join(posix.dirname(file), spec.replace(/\.js$/, ".ts"))));
      } else if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0] ?? "")) {
        findings.push({ file, code: "node_builtin", detail: spec });
      } else {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);
        if (!allowed.has(pkg)) findings.push({ file, code: "external_not_allowed", detail: spec });
      }
    }
  }
  return findings;
}

test("engine browser entries have no node: import in their static graph (Refs #420)", async () => {
  const failures: string[] = [];
  for (const item of ENGINE_PURE_ENTRIES) {
    const findings = await scanEngineEntry(item.entry, new Set(item.allowed));
    if (findings.length > 0) failures.push(`${item.name}:\n${JSON.stringify(findings, null, 2)}`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("engine browser entries bundle for platform browser with no Node builtin (Refs #420)", async () => {
  // The source walk above does not enter node_modules. This does: a second game's esbuild
  // `platform: "browser"` build of each published entry must resolve, and the output must not
  // keep a Node builtin (NodeIO's dynamic node:fs import is the case the walk cannot see).
  for (const spec of ["@kinetra/asset-pipeline/pure", "@kinetra/animation/contracts", "@kinetra/verification/browser"]) {
    const result = await build({
      stdin: {
        contents: `import * as entry from ${JSON.stringify(spec)};\nexport const names = Object.keys(entry);\n`,
        resolveDir: packageRoot,
        sourcefile: "second-game.mjs",
        loader: "js",
      },
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0, `${spec}: ${JSON.stringify(result.errors)}`);
    const [outputPath] = Object.keys(result.metafile?.outputs ?? {});
    assert.ok(outputPath, `${spec} produced no output`);
    const imports = result.metafile!.outputs[outputPath]!.imports.map((entryImport) => entryImport.path);
    assert.deepEqual(imports, [], `${spec} still imports ${imports.join(", ")}`);
    const text = result.outputFiles?.[0]?.text ?? "";
    assert.equal(text.includes("node:fs"), false, `${spec} output still mentions node:fs`);
    assert.equal(text.includes("node:path"), false, `${spec} output still mentions node:path`);
    assert.ok(text.includes("names"), `${spec} bundle is empty`);
  }
});

test("a commented-out Node import does not trip the scanner, a real one in a nested module does", async () => {
  const entry = "/v/index.ts";
  const clean = await scanPortability(entry, async (file) =>
    file === "/v/index.ts" ? `// import fs from "node:fs";\nexport const a = 1; // process.argv` : "",
  );
  assert.deepEqual(clean.findings, []);
  // A private method called `#require` and a property named like a global are not Node globals.
  const lookalikes = await scanPortability(entry, async () =>
    `class A { #require() { return 1; } run() { return this.#require() + this.process.argv.length + obj.Buffer.from(1); } }`,
  );
  assert.deepEqual(lookalikes.findings, []);
  const dirty = await scanPortability(entry, async (file) =>
    file === "/v/index.ts" ? `export * from "./deep/inner.js";` : `import { createHash } from "node:crypto";`,
  );
  assert.deepEqual(dirty.findings.map((finding) => finding.code), ["node_builtin"]);
});
