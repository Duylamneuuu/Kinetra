import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The README is the example's table of contents *and* its engine-feedback log, and every slice
 * edits it. Nothing used to stop it drifting from the tree: slice 46 found `src/sha256.ts` shipped
 * (and tested) for many slices without a row in the layout table. These checks read the README as
 * data and hold it to the tree:
 *
 * - every `src/*.ts` file is named in the README;
 * - every `acceptance/*.acceptance.json` manifest is named (by its short name or its file name);
 * - every backticked `src/...`, `test/...` or `acceptance/...` path the README cites exists;
 * - every `pnpm --filter @kinetra/example-orb-run <script>` it tells a reader to run is a script
 *   of this package;
 * - the numbered slice list counts 1, 2, 3, ... without a gap or a repeat, and only the last item
 *   may be the "Next:" pointer.
 *
 * The checkers are pure functions over strings, so the sabotage tests below prove each one fails
 * on a README that has drifted (a guard that cannot fail guards nothing).
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/test -> package root
const packageRoot = resolve(here, "..", "..");

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `name.ts` as a whole file name (so `check.ts` is not found inside `level-check.ts`). */
const mentionsFile = (readme: string, fileName: string): boolean =>
  new RegExp(`(?<![\\w./-])(?:src/)?${escapeRegExp(fileName)}(?![\\w-])`).test(readme);

export const findUndocumentedSources = (readme: string, sourceFiles: readonly string[]): string[] =>
  sourceFiles.filter((file) => !mentionsFile(readme, file)).sort();

export const findUndocumentedManifests = (readme: string, manifestFiles: readonly string[]): string[] =>
  manifestFiles
    .filter((file) => {
      const stem = file.replace(/\.acceptance\.json$/, "");
      return !(readme.includes(`\`${stem}\``) || readme.includes(file));
    })
    .sort();

/** `a/{x,y}.z` -> `a/x.z`, `a/y.z` (one brace group, the only shape the README uses). */
export const expandBraces = (path: string): string[] => {
  const match = /^(.*)\{([^{}]*)\}(.*)$/.exec(path);
  if (match === null) return [path];
  const [, head = "", options = "", tail = ""] = match;
  return options.split(",").map((option) => `${head}${option}${tail}`);
};

/** Backticked, wildcard-free paths under src/, test/ or acceptance/ that the README cites (braces expanded). */
export const citedPaths = (readme: string): string[] => {
  const found = new Set<string>();
  for (const match of readme.matchAll(/`((?:src|test|acceptance)\/[^`\s*]+\.[a-z]+)`/g)) {
    const path = match[1];
    if (path !== undefined) for (const expanded of expandBraces(path)) found.add(expanded);
  }
  return [...found].sort();
};

export const citedScripts = (readme: string): string[] => {
  const found = new Set<string>();
  for (const match of readme.matchAll(/pnpm --filter @kinetra\/example-orb-run ([\w:-]+)/g)) {
    const script = match[1];
    if (script !== undefined) found.add(script);
  }
  return [...found].sort();
};

export interface NumberedItemProblem {
  readonly kind: "gap" | "next-not-last";
  readonly detail: string;
}

/** The top-level numbered list ("12. **Slice 20: ...**"): contiguous from 1, "Next:" only last. */
export const checkNumberedList = (readme: string): NumberedItemProblem[] => {
  const items = [...readme.matchAll(/^(\d+)\. (.*)$/gm)].map((match) => ({
    n: Number(match[1]),
    text: match[2] ?? "",
  }));
  const problems: NumberedItemProblem[] = [];
  items.forEach((item, index) => {
    if (item.n !== index + 1) {
      problems.push({ kind: "gap", detail: `item ${index + 1} is numbered ${item.n}` });
    }
    if (item.text.startsWith("Next:") && index !== items.length - 1) {
      problems.push({ kind: "next-not-last", detail: `"Next:" is item ${item.n} of ${items.length}` });
    }
  });
  return problems;
};

const listNames = async (dir: string, suffix: string): Promise<string[]> =>
  (await readdir(resolve(packageRoot, dir))).filter((name) => name.endsWith(suffix)).sort();

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const readme = await readFile(resolve(packageRoot, "README.md"), "utf8");

test("every source file of the example is named in the README", async () => {
  const sources = await listNames("src", ".ts");
  assert.ok(sources.length >= 20, `expected the example's sources, found ${sources.length}`);
  assert.deepEqual(findUndocumentedSources(readme, sources), []);
});

test("every acceptance manifest of the example is named in the README", async () => {
  const manifests = await listNames("acceptance", ".acceptance.json");
  assert.ok(manifests.length >= 10, `expected the shipped manifests, found ${manifests.length}`);
  assert.deepEqual(findUndocumentedManifests(readme, manifests), []);
});

test("every src/, test/ and acceptance/ path the README cites exists", async () => {
  const cited = citedPaths(readme);
  assert.ok(cited.length >= 20, `expected the README to cite paths, found ${cited.length}`);
  const missing: string[] = [];
  for (const path of cited) {
    if (!(await exists(resolve(packageRoot, path)))) missing.push(path);
  }
  assert.deepEqual(missing, []);
});

test("every pnpm script the README tells a reader to run is a script of this package", async () => {
  const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const cited = citedScripts(readme);
  assert.ok(cited.includes("snapshot") && cited.includes("acceptance"), "README names the snapshot and acceptance scripts");
  assert.deepEqual(
    cited.filter((script) => pkg.scripts[script] === undefined),
    [],
  );
});

test("the numbered slice list is contiguous and only its last item may be the Next pointer", () => {
  assert.deepEqual(checkNumberedList(readme), []);
  const items = [...readme.matchAll(/^(\d+)\. /gm)];
  assert.ok(items.length >= 40, `expected the slice list, found ${items.length} items`);
});

// ---- the guards fail on a README that has drifted -------------------------------------------

test("sabotage: a source file the README never names is reported, a similar name does not hide it", () => {
  const base = "| `src/level-check.ts` | static check |\n| `src/hud.ts` | HUD |";
  assert.deepEqual(findUndocumentedSources(base, ["level-check.ts", "hud.ts"]), []);
  assert.deepEqual(findUndocumentedSources(base, ["level-check.ts", "hud.ts", "sha256.ts"]), ["sha256.ts"]);
  // `check.ts` is only a suffix of `level-check.ts`; it must not count as documented.
  assert.deepEqual(findUndocumentedSources(base, ["check.ts"]), ["check.ts"]);
  // Nor does another package's file of the same base name.
  assert.deepEqual(findUndocumentedSources("see `apps/player/src/hud.ts`", ["hud.ts"]), ["hud.ts"]);
});

test("sabotage: a manifest the README never names is reported by short name or file name", () => {
  assert.deepEqual(findUndocumentedManifests("`win`, `timeout`", ["win.acceptance.json", "level.acceptance.json"]), [
    "level.acceptance.json",
  ]);
  assert.deepEqual(findUndocumentedManifests("runs level.acceptance.json", ["level.acceptance.json"]), []);
  // A bare word is not a mention: only the backticked short name counts.
  assert.deepEqual(findUndocumentedManifests("the level is small", ["level.acceptance.json"]), ["level.acceptance.json"]);
});

test("sabotage: cited paths ignore globs and other packages' paths", () => {
  const text = "`src/a.ts` and `test/b.test.ts`, `acceptance/*.acceptance.json`, `apps/player/src/c.ts`, `test/` and `src/a.ts`";
  assert.deepEqual(citedPaths(text), ["src/a.ts", "test/b.test.ts"]);
  // A brace group names every alternative, so a stale one is caught too.
  assert.deepEqual(citedPaths("`acceptance/{win,gone}.acceptance.json`"), [
    "acceptance/gone.acceptance.json",
    "acceptance/win.acceptance.json",
  ]);
  assert.deepEqual(expandBraces("src/plain.ts"), ["src/plain.ts"]);
});

test("sabotage: cited scripts are read from the pnpm command", () => {
  assert.deepEqual(
    citedScripts("run `pnpm --filter @kinetra/example-orb-run snapshot` or pnpm --filter @kinetra/example-orb-run no-such-script."),
    ["no-such-script", "snapshot"],
  );
});

test("sabotage: a gap, a repeat, a restart and a Next pointer in the middle are all reported", () => {
  const ok = "1. **Slice 1**\n2. **Slice 2**\n3. Next: more";
  assert.deepEqual(checkNumberedList(ok), []);
  assert.equal(checkNumberedList("1. a\n3. b").length >= 1, true, "a gap");
  assert.equal(checkNumberedList("1. a\n2. b\n2. c").length >= 1, true, "a repeat");
  assert.equal(checkNumberedList("2. a\n3. b").length >= 1, true, "a list that does not start at 1");
  const middle = checkNumberedList("1. a\n2. Next: later\n3. b");
  assert.deepEqual(
    middle.map((problem) => problem.kind),
    ["next-not-last"],
  );
});
