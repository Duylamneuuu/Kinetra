import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticGlb } from "@kinetra/asset-pipeline";
import {
  BlenderBridgeError,
  BlenderGlbImporter,
  MAX_ERROR_STDERR_CHARS,
  NodeProcessRunner,
  blenderHeadlessArgs,
  parseBlenderManifest,
  runBlenderExport,
  type BlenderExportOptions,
  type ProcessRunner,
} from "../src/index.js";

const base: BlenderExportOptions = {
  blenderExecutable: "blender",
  sourceBlend: "hero.blend",
  outputGlb: "out/hero.glb",
  pythonScript: "export.py",
};

function okRunner(calls: Array<{ exe: string; args: string[] }> = []): ProcessRunner {
  return {
    async run(exe, args) {
      calls.push({ exe, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function isBridgeError(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof BlenderBridgeError, `expected BlenderBridgeError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  };
}

/** Deterministic xorshift32 so the fuzz cases are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

const ALPHABET = ["a", "Z", "0", "-", "_", ".", "/", " ", "é", "ü", "\\", "--", "=", "😀"];

function randomPath(next: () => number): string {
  const length = 1 + Math.floor(next() * 12);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out.trim().length === 0 ? `x${out}` : out;
}

test("argument shape is invariant and no path argument is ever parsed as a flag (fuzz, 500 cases)", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const next = rng(seed);
    const input = {
      ...base,
      sourceBlend: randomPath(next),
      pythonScript: randomPath(next),
      outputGlb: randomPath(next),
    };
    const args = blenderHeadlessArgs(input);
    assert.equal(args.length, 7, `seed ${seed}`);
    assert.deepEqual([args[0], args[2], args[4], args[5]], ["--background", "--python", "--", "--output"]);
    for (const [index, original] of [
      [1, input.sourceBlend],
      [3, input.pythonScript],
      [6, input.outputGlb],
    ] as const) {
      const value = args[index]!;
      assert.ok(!value.startsWith("-"), `seed ${seed}: ${JSON.stringify(value)} would be read as a flag`);
      assert.equal(value, original.startsWith("-") ? `./${original}` : original, `seed ${seed}`);
    }
    // Pure: same input gives the same output.
    assert.deepEqual(blenderHeadlessArgs(input), args);
  }
});

test("regression: relative paths starting with '-' are prefixed with ./", () => {
  const args = blenderHeadlessArgs({
    ...base,
    sourceBlend: "--python-expr=import os",
    pythonScript: "-P.py",
    outputGlb: "-out.glb",
  });
  assert.deepEqual(args, [
    "--background",
    "./--python-expr=import os",
    "--python",
    "./-P.py",
    "--",
    "--output",
    "./-out.glb",
  ]);
});

test("rejects empty, whitespace, non-string and NUL-containing options with structured errors", async () => {
  for (const key of ["sourceBlend", "pythonScript", "outputGlb"] as const) {
    for (const bad of ["", "   ", 42, null, undefined, {}, "a\0b"]) {
      assert.throws(
        () => blenderHeadlessArgs({ ...base, [key]: bad } as unknown as BlenderExportOptions),
        isBridgeError("blender.invalidOption"),
        `${key}=${JSON.stringify(bad)}`,
      );
    }
  }
  const calls: Array<{ exe: string; args: string[] }> = [];
  for (const bad of ["", " ", 7]) {
    await assert.rejects(
      runBlenderExport({ ...base, blenderExecutable: bad } as unknown as BlenderExportOptions, okRunner(calls)),
      isBridgeError("blender.invalidOption"),
    );
  }
  assert.equal(calls.length, 0, "runner must not be invoked for invalid options");
});

test("runner rejection becomes blender.spawnFailed", async () => {
  const runner: ProcessRunner = {
    async run() {
      throw Object.assign(new Error("spawn blender ENOENT"), { code: "ENOENT" });
    },
  };
  await assert.rejects(runBlenderExport(base, runner), (err: unknown) => {
    isBridgeError("blender.spawnFailed")(err);
    assert.match((err as Error).message, /ENOENT/);
    return true;
  });
});

test("non-zero exit keeps the legacy message prefix, bounds stderr and reports the signal", async () => {
  const huge = `${"x".repeat(50_000)}TAIL_MARKER`;
  const runner: ProcessRunner = {
    async run() {
      return { code: -1, stdout: "", stderr: huge, signal: "SIGKILL" };
    },
  };
  await assert.rejects(runBlenderExport(base, runner), (err: unknown) => {
    isBridgeError("blender.exportFailed")(err);
    const error = err as BlenderBridgeError;
    assert.ok(error.message.startsWith("Blender export failed with code -1 (signal SIGKILL): "));
    assert.ok(error.message.endsWith("TAIL_MARKER"));
    assert.ok(error.message.length < MAX_ERROR_STDERR_CHARS + 200);
    assert.equal(error.details.signal, "SIGKILL");
    return true;
  });
});

test("NodeProcessRunner captures complete output, exit code and bounds memory", async () => {
  const runner = new NodeProcessRunner();
  const script = "process.stdout.write('o'.repeat(200000));process.stderr.write('ERR');process.exitCode=3";
  const result = await runner.run(process.execPath, ["-e", script]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout.length, 200_000, "close-based runner must not lose buffered stdout");
  assert.equal(result.stderr, "ERR");
  assert.equal(result.signal, null);

  const bounded = new NodeProcessRunner({ maxOutputChars: 1000 });
  const small = await bounded.run(process.execPath, ["-e", "process.stdout.write('a'.repeat(5000)+'END')"]);
  assert.equal(small.stdout.length, 1000);
  assert.ok(small.stdout.endsWith("END"));
});

test("NodeProcessRunner rejects when the executable does not exist", async () => {
  await assert.rejects(new NodeProcessRunner().run("/nonexistent/kinetra-blender-binary", []));
  await assert.rejects(
    runBlenderExport({ ...base, blenderExecutable: "/nonexistent/kinetra-blender-binary" }),
    isBridgeError("blender.spawnFailed"),
  );
});

test("NodeProcessRunner kills a hung process and reports blender.timeout", async () => {
  const hang = "setInterval(() => {}, 1000)";
  const runner = new NodeProcessRunner({ timeoutMs: 200 });
  const started = Date.now();
  const hung = await runner.run(process.execPath, ["-e", hang]);
  assert.equal(hung.timedOut, true);
  assert.equal(hung.signal, "SIGKILL");
  assert.ok(Date.now() - started < 10_000, "the hung process must be killed promptly");

  await assert.rejects(
    runBlenderExport(
      { ...base, blenderExecutable: process.execPath },
      { run: (exe) => new NodeProcessRunner({ timeoutMs: 200 }).run(exe, ["-e", hang]) },
    ),
    isBridgeError("blender.timeout"),
  );
});

test(
  "NodeProcessRunner timeout resolves even when a grandchild keeps the stdio pipes open (launcher-script Blender)",
  { skip: process.platform === "win32" },
  async () => {
    // The child spawns a grandchild that inherits stdout/stderr and then both hang,
    // like a `blender` shell wrapper whose real binary outlives the wrapper. The
    // grandchild stops itself after 8 s so a failing run cannot leak it forever.
    const script =
      "const { spawn } = require('node:child_process');" +
      "spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 8000)'], { stdio: 'inherit' });" +
      "setInterval(() => {}, 1000)";
    const runner = new NodeProcessRunner({ timeoutMs: 300 });
    const started = Date.now();
    let guard: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      runner.run(process.execPath, ["-e", script]),
      new Promise<"hung">((resolve) => {
        guard = setTimeout(() => resolve("hung"), 4000);
      }),
    ]);
    clearTimeout(guard);
    assert.notEqual(outcome, "hung", "run() must settle shortly after the timeout, not wait for the grandchild");
    assert.equal((outcome as { timedOut?: boolean }).timedOut, true);
    assert.ok(Date.now() - started < 4000);
  },
);

test("NodeProcessRunner does not flag a process that finishes within its limit", async () => {
  const result = await new NodeProcessRunner({ timeoutMs: 30_000 }).run(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, undefined);
});

test("NodeProcessRunner rejects non-positive or non-finite timeouts", () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new NodeProcessRunner({ timeoutMs }), isBridgeError("blender.invalidOption"));
  }
});

test("a custom runner that reports timedOut produces blender.timeout, not exportFailed", async () => {
  const runner: ProcessRunner = {
    async run() {
      return { code: -1, stdout: "", stderr: "", signal: "SIGKILL", timedOut: true };
    },
  };
  await assert.rejects(runBlenderExport(base, runner), isBridgeError("blender.timeout"));
});

class MemoryFs {
  readonly files = new Map<string, Uint8Array>();
  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT: ${path}`);
    return data;
  }
}

function context(settings: Record<string, unknown>, targetPath = "/staging/a.glb") {
  return {
    assetId: "asset_a",
    sourcePath: "/src/a.blend",
    sourceBytes: new Uint8Array([0]),
    sourceHash: "h",
    recipe: { importer: "blender-glb", importerVersion: "1", settings },
    targetPath,
  };
}

test("importer rejects non-string recipe overrides before spawning Blender", async () => {
  for (const settings of [
    { blenderExecutable: 5 },
    { blenderExecutable: "" },
    { pythonScript: { path: "x" } },
    { pythonScript: null },
  ]) {
    const calls: Array<{ exe: string; args: string[] }> = [];
    const importer = new BlenderGlbImporter({ runner: okRunner(calls), fileSystem: new MemoryFs() });
    await assert.rejects(importer.import(context(settings)), isBridgeError("blender.invalidOption"));
    assert.equal(calls.length, 0, JSON.stringify(settings));
  }
});

test("importer refuses recipe-chosen executables/scripts unless the host opts in, without spawning", async () => {
  for (const settings of [
    { blenderExecutable: "/tmp/evil" },
    { pythonScript: "/tmp/evil.py" },
    { blenderExecutable: "/tmp/evil", pythonScript: "/tmp/evil.py" },
  ]) {
    const calls: Array<{ exe: string; args: string[] }> = [];
    const importer = new BlenderGlbImporter({ runner: okRunner(calls), fileSystem: new MemoryFs() });
    await assert.rejects(importer.import(context(settings)), (err: unknown) => {
      isBridgeError("blender.invalidOption")(err);
      assert.equal((err as BlenderBridgeError).details.reason, "recipeOverrideNotAllowed");
      return true;
    });
    assert.equal(calls.length, 0, JSON.stringify(settings));
  }
});

test("importer without overrides in the recipe still uses its configured executable", async () => {
  const calls: Array<{ exe: string; args: string[] }> = [];
  const importer = new BlenderGlbImporter({
    blenderExecutable: "configured-blender",
    runner: okRunner(calls),
    fileSystem: new MemoryFs(),
  });
  await importer.import(context({ unrelated: true })).catch(() => undefined);
  assert.equal(calls[0]?.exe, "configured-blender");
});

test("importer reports a missing GLB as blender.outputMissing naming both candidate paths", async () => {
  const importer = new BlenderGlbImporter({ runner: okRunner(), fileSystem: new MemoryFs() });
  await assert.rejects(importer.import(context({})), (err: unknown) => {
    isBridgeError("blender.outputMissing")(err);
    assert.match((err as Error).message, /\/staging\/a\.glb" or "\/staging\/a\.glb\.glb"/);
    return true;
  });
});

test("importer falls back to <target>.glb when Blender appended an extension", async () => {
  const fs = new MemoryFs();
  const glb = await createSyntheticGlb({ size: [1, 1, 1] });
  fs.files.set("/staging/a.glb.glb", glb);
  const importer = new BlenderGlbImporter({ runner: okRunner(), fileSystem: fs });
  const result = await importer.import(context({}));
  assert.deepEqual(result.artifactBytes, glb);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.metadata?.custom, undefined);
});

test("malformed manifest is a warning diagnostic, not a silent drop or a crash", async () => {
  const fs = new MemoryFs();
  fs.files.set("/staging/a.glb", await createSyntheticGlb({ size: [1, 1, 1] }));
  fs.files.set("/staging/a.glb.manifest.json", new TextEncoder().encode("{not json"));
  const importer = new BlenderGlbImporter({ runner: okRunner(), fileSystem: fs });
  const result = await importer.import(context({}));
  assert.equal(result.metadata?.custom, undefined);
  assert.equal(result.diagnostics?.length, 1);
  assert.equal(result.diagnostics?.[0]?.code, "blender.manifestInvalid");
  assert.equal(result.diagnostics?.[0]?.severity, "warning");
  assert.equal(result.diagnostics?.[0]?.path, "/staging/a.glb.manifest.json");
});

test("parseBlenderManifest keeps well-typed fields and flags the rest", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const good = parseBlenderManifest(
    encode({ blenderVersion: "4.2.0", actions: ["Run"], armatures: [], meshes: ["Body"], objects: [] }),
    "m.json",
  );
  assert.deepEqual(good.manifest, { blenderVersion: "4.2.0", actions: ["Run"], armatures: [], meshes: ["Body"] });
  assert.deepEqual(good.diagnostics, []);

  const mixed = parseBlenderManifest(encode({ blenderVersion: 4, actions: "Run", meshes: [1, "a"] }), "m.json");
  assert.deepEqual(mixed.manifest, {});
  assert.deepEqual(
    mixed.diagnostics.map((d) => d.code),
    ["blender.manifestFieldInvalid", "blender.manifestFieldInvalid", "blender.manifestFieldInvalid"],
  );

  for (const value of [null, [], "text", 3]) {
    const parsed = parseBlenderManifest(encode(value), "m.json");
    assert.equal(parsed.manifest, undefined, JSON.stringify(value));
    assert.equal(parsed.diagnostics[0]?.code, "blender.manifestInvalid");
  }
});

test("parseBlenderManifest never throws on arbitrary bytes (fuzz, 300 cases)", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const next = rng(seed * 7919);
    const bytes = new Uint8Array(Math.floor(next() * 64));
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(next() * 256);
    const parsed = parseBlenderManifest(bytes, "m.json");
    for (const d of parsed.diagnostics) assert.equal(d.severity, "warning");
  }
});
