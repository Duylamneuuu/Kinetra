import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** Same scanner as entry-portability.test.ts (kept local so importing it does not re-run its tests). */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const importSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  for (const match of stripComments(source).matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) out.push(spec);
  }
  return out;
};

/**
 * `entry-portability.test.ts` proves the orb-run entry's *own* source graph is browser-safe and
 * only imports an allow-list of `@kinetra/*` packages. This test follows those packages too: it
 * walks the source import graph across package boundaries (barrel `src/index.ts` of each
 * `@kinetra/*` package the entry reaches) and builds a ledger of which engine packages drag Node
 * builtins into a would-be renderer bundle.
 *
 * Two rules are enforced:
 *  1. Packages that are clean today (`CLEAN_PACKAGES`) must stay clean, transitively.
 *  2. Any other package the entry reaches must stay inside `NODE_DEBT`. That ledger is empty:
 *     the game imports browser-safe subpaths (#420), so a Node builtin anywhere on this graph fails.
 */

const toPosix = (path: string): string => path.replace(/\\/g, "/");

const here = dirname(fileURLToPath(import.meta.url));
// dist/test -> package root -> repo root
const packageRoot = resolve(here, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");

/** Engine packages whose barrel (and everything behind it) must stay free of Node builtins. */
const CLEAN_PACKAGES: readonly string[] = [
  "@kinetra/core",
  "@kinetra/command-bus",
  "@kinetra/project-model",
  "@kinetra/audio",
];

/**
 * Upper bound of Node builtins each engine package may reach through the entry the game actually
 * imports. The renderer-facing subpaths (`asset-pipeline/pure`, `animation/blend-space` and
 * `animation/ik`, `verification/browser`) pay #420 down to nothing. A new builtin fails the test;
 * the Node barrels (`src/index.ts`) are no longer on this graph.
 */
const NODE_DEBT: Readonly<Record<string, readonly string[]>> = {};

const NODE_BUILTIN_BASES = new Set([
  "assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "net", "os", "path",
  "process", "readline", "stream", "url", "util", "vm", "worker_threads", "zlib",
]);

const builtinName = (spec: string): string | undefined => {
  if (spec.startsWith("node:")) return spec;
  return NODE_BUILTIN_BASES.has(spec.split("/")[0] ?? "") ? `node:${spec}` : undefined;
};

export interface PackageReach {
  /** `@kinetra/*` packages reached (transitively), including the starting package's own deps. */
  readonly packages: Set<string>;
  /** package name -> Node builtins imported by files of that package that are reachable. */
  readonly builtins: Map<string, Set<string>>;
  readonly unresolved: string[];
  readonly files: number;
}

export type PackageDirs = ReadonlyMap<string, string>;

/**
 * Walk the source graph from `entry`. Relative imports stay in the current package; a bare
 * `@kinetra/x` import continues at that package's `src/index.ts`. `owner` names the package a file
 * belongs to so builtins are attributed to the right engine package.
 */
export const walkPackages = async (
  entry: string,
  entryOwner: string,
  packageDirs: PackageDirs,
  readSource: (file: string) => Promise<string>,
): Promise<PackageReach> => {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const builtins = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  const queue: Array<{ file: string; owner: string }> = [{ file: entry, owner: entryOwner }];
  while (queue.length > 0) {
    const { file, owner } = queue.shift() as { file: string; owner: string };
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = await readSource(file);
    } catch {
      unresolved.push(file);
      continue;
    }
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith(".")) {
        queue.push({ file: posix.normalize(posix.join(posix.dirname(file), spec.replace(/\.js$/, ".ts"))), owner });
        continue;
      }
      const builtin = builtinName(spec);
      if (builtin !== undefined) {
        const set = builtins.get(owner) ?? new Set<string>();
        set.add(builtin);
        builtins.set(owner, set);
        continue;
      }
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);
      const dir = packageDirs.get(name);
      if (dir === undefined) continue; // third-party package: out of scope here (entry-portability allow-lists)
      packages.add(name);
      // `@kinetra/pkg/subpath` continues at that file, not the Node barrel (`src/index.ts`).
      const subpath = spec.startsWith(`${name}/`) ? spec.slice(name.length + 1).replace(/\.js$/, "") : "";
      const entryFile = subpath === "" ? "src/index.ts" : `src/${subpath}.ts`;
      queue.push({ file: posix.join(dir, entryFile), owner: name });
    }
  }
  return { packages, builtins, unresolved: unresolved.sort(), files: seen.size };
};

const loadPackageDirs = async (): Promise<Map<string, string>> => {
  const dirs = new Map<string, string>();
  const packagesDir = resolve(repoRoot, "packages");
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(resolve(packagesDir, entry.name, "package.json"), "utf8")) as { name?: string };
      if (typeof manifest.name === "string") dirs.set(manifest.name, toPosix(resolve(packagesDir, entry.name)));
    } catch {
      // not a package directory
    }
  }
  return dirs;
};

const readDisk = (file: string): Promise<string> => readFile(file, "utf8");

const scanEntry = async (): Promise<PackageReach> => {
  const dirs = await loadPackageDirs();
  return walkPackages(toPosix(resolve(packageRoot, "src", "index.ts")), "@kinetra/example-orb-run", dirs, readDisk);
};

test("the engine packages the entry reaches are discovered across package boundaries", async () => {
  const reach = await scanEntry();
  assert.deepEqual(reach.unresolved, [], `unreadable sources: ${reach.unresolved.join(", ")}`);
  for (const name of ["@kinetra/core", "@kinetra/command-bus", "@kinetra/project-model", "@kinetra/animation", "@kinetra/verification"]) {
    assert.ok(reach.packages.has(name), `${name} is reachable from the entry`);
  }
  assert.ok(!reach.packages.has("@kinetra/navigation-recast"), "Recast navigation is not reachable from the entry");
  assert.ok(reach.files >= 50, `walked ${reach.files} files across packages`);
});

test("clean engine packages stay free of Node builtins, transitively", async () => {
  const reach = await scanEntry();
  const dirty = CLEAN_PACKAGES.filter((name) => reach.builtins.has(name)).map((name) => `${name}: ${[...(reach.builtins.get(name) ?? [])].join(", ")}`);
  assert.deepEqual(dirty, [], `a clean package now reaches Node builtins:\n${dirty.join("\n")}`);
  for (const name of CLEAN_PACKAGES) assert.ok(reach.packages.has(name), `${name} is expected to be reachable`);
});

test("Node-builtin debt of the other engine packages never grows beyond the ledger", async () => {
  const reach = await scanEntry();
  const growth: string[] = [];
  for (const [name, modules] of reach.builtins) {
    if (name === "@kinetra/example-orb-run") continue; // covered by entry-portability.test.ts
    const allowed = new Set(NODE_DEBT[name] ?? []);
    const extra = [...modules].filter((module) => !allowed.has(module)).sort();
    if (extra.length > 0) growth.push(`${name}: ${extra.join(", ")}`);
  }
  assert.deepEqual(growth.sort(), [], `new Node builtins reach the entry via engine packages:\n${growth.join("\n")}`);
});

test("walkPackages attributes builtins to the owning package and follows barrels (sabotage on a virtual tree)", async () => {
  const dirs = new Map([
    ["@kinetra/clean", "/p/clean"],
    ["@kinetra/dirty", "/p/dirty"],
  ]);
  const files: Record<string, string> = {
    "/g/index.ts": `import { a } from "@kinetra/clean";\nimport { b } from "@kinetra/dirty";\nimport "lodash";\nexport { a, b };`,
    "/p/clean/src/index.ts": `export * from "./inner.js";`,
    "/p/clean/src/inner.ts": `export const a = 1;`,
    "/p/dirty/src/index.ts": `import { readFile } from "node:fs/promises";\nexport * from "./deep.js";\nexport const b = readFile;`,
    "/p/dirty/src/deep.ts": `import { createHash } from "crypto";\nexport const h = createHash;\nimport "./missing.js";`,
  };
  const reach = await walkPackages("/g/index.ts", "@kinetra/game", dirs, async (file) => {
    const text = files[file];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  });
  assert.deepEqual([...reach.packages].sort(), ["@kinetra/clean", "@kinetra/dirty"]);
  assert.equal(reach.builtins.has("@kinetra/clean"), false);
  assert.deepEqual([...(reach.builtins.get("@kinetra/dirty") ?? [])].sort(), ["node:crypto", "node:fs/promises"]);
  assert.deepEqual(reach.unresolved, ["/p/dirty/src/missing.ts"]);
});
