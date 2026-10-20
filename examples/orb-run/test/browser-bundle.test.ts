import assert from "node:assert/strict";
import { dirname } from "node:path";
import test, { before } from "node:test";
import { createContext, runInContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { createOrbRunReplays, playOrbRunReplay, type OrbRunReplay } from "../src/index.js";
import { buildBrowserSandbox, nodeBuiltinStubs, type BrowserSandbox } from "./browser-host.js";

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
 * bytes and digests as the Node build, and the bundle imports no Node builtin (#420). The stub
 * plugin stays so a regression that reintroduces `node:fs` fails this test instead of being
 * polyfilled.
 */

const here = dirname(fileURLToPath(import.meta.url));
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

let sandbox: BrowserSandbox<Bundled>;

before(async () => {
  sandbox = await buildBrowserSandbox<Bundled>();
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
  // #420: the renderer entry reaches browser-safe package subpaths, so the bundle imports no Node
  // builtin at all. A new one fails here.
  assert.deepEqual(sandbox.stubbed, [], `Node builtins still reachable from the entry: ${sandbox.stubbed.join(", ")}`);
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
