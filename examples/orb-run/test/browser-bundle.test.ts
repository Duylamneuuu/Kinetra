import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test, { before } from "node:test";
import { createContext, runInContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

import { createOrbRunReplays, playOrbRunReplay, type OrbRunReplay } from "../src/index.js";

/**
 * Slice 41 (`real-bundle`) bundled the entry for `platform: "node"`, so the Node builtins stayed
 * external and *worked*. That does not tell whether a renderer, which has none of them, could play
 * the game. This test removes them for real:
 *
 *  - esbuild bundles the entry for `platform: "browser"` as one IIFE; every Node builtin the graph
 *    still imports is replaced by a stub that has the real module's export names but whose every
 *    function records the call and throws;
 *  - the bundle runs in a `node:vm` context that has the globals a browser has (`structuredClone`,
 *    `TextEncoder`, `URL`, timers, `AbortController`) and none of Node's (`process`, `Buffer`,
 *    `require`, `setImmediate`, `__dirname`);
 *  - the game is then played through that bundle.
 *
 * It proves the *play path* of the game needs no Node API: replays record, play and verify to the same
 * bytes and digests as the Node build, and no stubbed builtin is ever called. The builtins are still
 * imported (the asset pipeline and animation loaders): the bundle only works because they are not
 * called while playing, which is exactly what this test pins.
 */

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "..", "dist", "src", "index.js");

const NODE_BUILTIN = /^(?:node:.+|(?:fs|path|crypto|os|url|module|child_process|net|readline|util|stream|buffer|events|assert|zlib|worker_threads|perf_hooks|process|timers)(?:\/.*)?)$/;

const STRUCTURED_CLONE_IN_REALM = `
globalThis.structuredClone = function structuredClone(value) {
  const seen = new Map();
  const copy = (v) => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "function" || typeof v === "symbol") throw new Error("DataCloneError: " + typeof v);
      return v;
    }
    if (seen.has(v)) return seen.get(v);
    let out;
    if (Array.isArray(v)) { out = []; seen.set(v, out); v.forEach((item, i) => { out[i] = copy(item); }); return out; }
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof Map) { out = new Map(); seen.set(v, out); v.forEach((item, key) => out.set(copy(key), copy(item))); return out; }
    if (v instanceof Set) { out = new Set(); seen.set(v, out); v.forEach((item) => out.add(copy(item))); return out; }
    if (ArrayBuffer.isView(v)) return new v.constructor(v);
    out = {}; seen.set(v, out);
    for (const key of Object.keys(v)) out[key] = copy(v[key]);
    return out;
  };
  return copy(value);
};`;

interface Bundled {
  createOrbRunReplays: () => Promise<{ win: OrbRunReplay; timeout: OrbRunReplay }>;
  recordOrbRunReplay: (
    drive: (simulation: { advance: (steps: number) => void }) => void | Promise<void>,
    options?: { checkpointEvery?: number },
  ) => Promise<OrbRunReplay>;
  playOrbRunReplay: (
    replay: unknown,
    options?: { maxSteps?: number },
  ) => Promise<{ verified: boolean; finalDigest: string; summary: { status: string; step: number; collectedCount: number } }>;
}

interface Sandbox {
  bundle: Bundled;
  context: object;
  calls: () => string[];
  stubbed: string[];
  warnings: string[];
}

let sandbox: Sandbox;

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default";
}

/** Replaces every Node builtin with a module that has the real export names and throws when called. */
function nodeBuiltinStubs(stubbed: Set<string>): Plugin {
  return {
    name: "node-builtin-stubs",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: NODE_BUILTIN }, (args) => ({ path: args.path.replace(/^node:/, ""), namespace: "node-stub" }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, async (args) => {
        stubbed.add(args.path);
        const real = (await import(`node:${args.path}`)) as Record<string, unknown>;
        const names = Object.keys(real).filter(isIdentifier);
        const lines = [
          `const trap = (label) => function () { (globalThis.__nodeBuiltinCalls ??= []).push(label); throw new Error("Node builtin used in the browser bundle: " + label); };`,
          ...names.map((name) => `export const ${name} = trap(${JSON.stringify(`${args.path}.${name}`)});`),
          `export default { ${names.map((name) => `${name}`).join(", ")} };`,
        ];
        return { contents: lines.join("\n"), loader: "js" };
      });
    },
  };
}

before(async () => {
  const stubbed = new Set<string>();
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "OrbRunBundle",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    plugins: [nodeBuiltinStubs(stubbed)],
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  const code = result.outputFiles?.[0]?.text;
  assert.ok(code, "esbuild produced the bundle");

  const context = createContext({
    console,
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
  });
  // `structuredClone` is installed from *inside* the context: the host's would build the clones in the
  // host realm, whose `Object.prototype` is not the sandbox's, and the engine's plain-object checks would
  // (rightly, for a cross-realm object) refuse them. A browser has one realm, so this is its behaviour.
  new Script(STRUCTURED_CLONE_IN_REALM, { filename: "structured-clone.js" }).runInContext(context);
  new Script(code, { filename: "orb-run.browser.js" }).runInContext(context);
  const bundle = runInContext("OrbRunBundle", context) as Bundled;
  sandbox = {
    bundle,
    context,
    calls: () => Array.from(runInContext("globalThis.__nodeBuiltinCalls ?? []", context) as string[]),
    stubbed: [...stubbed].sort(),
    warnings: result.warnings.map((warning) => warning.text),
  };
});

test("the sandbox is browser-shaped: none of Node's globals exist in it", () => {
  for (const name of ["process", "Buffer", "require", "module", "setImmediate", "clearImmediate", "__dirname", "__filename", "global"]) {
    assert.equal(runInContext(`typeof ${name}`, sandbox.context), "undefined", `${name} must not exist in the browser sandbox`);
  }
  for (const name of ["structuredClone", "TextEncoder", "URL", "setTimeout", "AbortController"]) {
    assert.equal(runInContext(`typeof ${name}`, sandbox.context), "function", `${name} is what a browser offers`);
  }
});

test("the entry bundles for the browser platform with Node builtins stubbed, without bundler warnings", () => {
  // The builtins the graph still imports are the measured debt of slices 24 and 41; stubbing them is
  // what makes the browser bundle buildable at all. A new one fails here.
  const allowed = new Set(["crypto", "fs", "fs/promises", "path"]);
  const extra = sandbox.stubbed.filter((name) => !allowed.has(name));
  assert.deepEqual(extra, [], `new Node builtins reachable from the entry: ${extra.join(", ")}`);
  assert.deepEqual(sandbox.warnings, [], "esbuild reports nothing suspicious (no import.meta / eval / require it could not follow)");
  assert.equal(typeof sandbox.bundle.createOrbRunReplays, "function");
});

test("the browser-sandboxed game records byte-identical replays to the Node build", async () => {
  const fromSource = await createOrbRunReplays();
  const fromBrowser = await sandbox.bundle.createOrbRunReplays();
  assert.equal(JSON.stringify(fromBrowser.win), JSON.stringify(fromSource.win));
  assert.equal(JSON.stringify(fromBrowser.timeout), JSON.stringify(fromSource.timeout));
  assert.equal(fromBrowser.win.outcome.status, "won");
  assert.deepEqual(sandbox.calls(), [], "playing needed no Node builtin");
});

test("the committed golden replays verify inside the browser sandbox to the same digests", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["win", "timeout"] as const) {
    const url = new URL(`../../acceptance/replays/${name}.replay.json`, import.meta.url);
    const committed = JSON.parse(await readFile(url, "utf8")) as OrbRunReplay;
    const viaBrowser = await sandbox.bundle.playOrbRunReplay(committed);
    const viaSource = await playOrbRunReplay(committed);
    assert.equal(viaBrowser.verified, true, `${name}.replay.json verifies in the sandbox`);
    assert.equal(viaBrowser.finalDigest, viaSource.finalDigest);
    assert.equal(viaBrowser.summary.status, viaSource.summary.status);
    assert.equal(viaBrowser.summary.collectedCount, viaSource.summary.collectedCount);
  }
  assert.deepEqual(sandbox.calls(), [], "verifying replays needed no Node builtin");
});

test("a long replay, which must yield to its host, plays in a host without setImmediate", async () => {
  // 2048 steps is the yield interval; 5000 crosses it twice. Browsers have no `setImmediate`.
  const steps = 2 * 2048 + 904;
  const replay = await sandbox.bundle.recordOrbRunReplay((simulation) => simulation.advance(steps), { checkpointEvery: 1000 });
  const viaBrowser = await sandbox.bundle.playOrbRunReplay(replay);
  assert.equal(viaBrowser.verified, true);
  assert.equal(viaBrowser.summary.step, steps);
  const viaSource = await playOrbRunReplay(JSON.parse(JSON.stringify(replay)) as OrbRunReplay);
  assert.equal(viaBrowser.finalDigest, viaSource.finalDigest);
  assert.deepEqual(sandbox.calls(), []);
});

test("the stubs are real traps: calling a stubbed builtin throws and is recorded", () => {
  // Proof the "no builtin was called" assertions above can fail: a bundle that does call fs is caught.
  // Direct check of the stub generator through a tiny bundle of its own.
  return build({
    stdin: { contents: `import { readFileSync } from "node:fs"; export const read = () => readFileSync("/etc/hostname");`, resolveDir: here, loader: "js" },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "Probe",
    platform: "browser",
    logLevel: "silent",
    plugins: [nodeBuiltinStubs(new Set())],
  }).then((result) => {
    const context = createContext({});
    new Script(result.outputFiles![0]!.text).runInContext(context);
    assert.throws(() => runInContext("Probe.read()", context), /Node builtin used in the browser bundle: fs\.readFileSync/);
    assert.deepEqual(Array.from(runInContext("globalThis.__nodeBuiltinCalls", context) as string[]), ["fs.readFileSync"]);
  });
});
