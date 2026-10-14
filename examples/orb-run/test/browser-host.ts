import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { createContext, runInContext, Script } from "node:vm";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

/**
 * Shared by the browser-shaped tests (`browser-bundle`, `browser-play-path`): bundle the built entry for
 * `platform: "browser"` with every Node builtin stubbed by a trap, and load the result into a `node:vm`
 * context that has the globals a browser has and none of Node's. Not a test itself (no `.test` suffix, so
 * the `dist/test/*.test.js` glob does not run it).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const orbRunEntry = resolve(here, "..", "..", "dist", "src", "index.js");

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

export interface BrowserSandbox<Bundle> {
  bundle: Bundle;
  context: object;
  /** Labels of every stubbed Node builtin that was called (should stay empty while playing). */
  calls: () => string[];
  /** Node builtins the graph still imports (stubbed). */
  stubbed: string[];
  warnings: string[];
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default";
}

/** Replaces every Node builtin with a module that has the real export names and throws when called. */
export function nodeBuiltinStubs(stubbed: Set<string>): Plugin {
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

export async function buildBrowserSandbox<Bundle>(): Promise<BrowserSandbox<Bundle>> {
  const stubbed = new Set<string>();
  const result = await build({
    entryPoints: [orbRunEntry],
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
  const bundle = runInContext("OrbRunBundle", context) as Bundle;
  return {
    bundle,
    context,
    calls: () => Array.from(runInContext("globalThis.__nodeBuiltinCalls ?? []", context) as string[]),
    stubbed: [...stubbed].sort(),
    warnings: result.warnings.map((warning) => warning.text),
  };
}
