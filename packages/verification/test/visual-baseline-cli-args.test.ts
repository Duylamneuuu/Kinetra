import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodePng, runVisualBaselineCli } from "../src/index.js";

function solid(value: number): Uint8Array {
  const width = 16;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([value, value, value, 255], i * 4);
  }
  return encodePng({ width, height, data });
}

async function withDirectory(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-baseline-cli-args-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { env: {}, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test("argument errors name the problem and print usage, never run the command", async () => {
  const cases: Array<{ args: string[]; message: RegExp }> = [
    { args: ["check", "a.json", "frames", "--tolerance", ""], message: /--tolerance must be a number \(got ""\)/ },
    { args: ["check", "a.json", "frames", "--tolerance", "   "], message: /--tolerance must be a number/ },
    { args: ["check", "a.json", "frames", "--tolerance", "Infinity"], message: /--tolerance must be a number/ },
    { args: ["check", "a.json", "frames", "--tolerance", "NaN"], message: /--tolerance must be a number/ },
    { args: ["check", "a.json", "frames", "--report-dir"], message: /--report-dir needs a value/ },
    { args: ["update", "a.json", "frames", "--only"], message: /--only needs a value/ },
    { args: ["update", "a.json", "frames", "--only", ""], message: /--only needs at least one frame name/ },
    { args: ["check", "a.json", "frames", "extra"], message: /expected <baselines\.json> and <frames-dir>/ },
    { args: ["check", "a.json", "frames", "--bogus"], message: /unknown option --bogus/ },
    { args: ["Check", "a.json", "frames"], message: /unknown command "Check"/ },
  ];
  for (const { args, message } of cases) {
    const run = capture();
    assert.equal(await runVisualBaselineCli(args, run.io), 2, args.join(" "));
    assert.match(run.err(), message, args.join(" "));
    assert.match(run.err(), /usage:/, args.join(" "));
    assert.equal(run.out(), "", `${args.join(" ")} must not write to stdout`);
  }
});

test("a frames path that is a file (ENOTDIR) is reported as exit 2, not thrown", async () => {
  await withDirectory(async (dir) => {
    const notDirectory = join(dir, "frames.png");
    await writeFile(notDirectory, solid(10));
    const run = capture();
    assert.equal(await runVisualBaselineCli(["check", join(dir, "b.json"), notDirectory], run.io), 2);
    assert.match(run.err(), /ENOTDIR|not a directory/i);
  });
});

test("frame files are matched by a case-insensitive .png extension and named without it", async () => {
  await withDirectory(async (dir) => {
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "Menu.PNG"), solid(40));
    await writeFile(join(frames, "readme.txt"), "ignored");
    const baselines = join(dir, "baselines.json");
    const update = capture();
    assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm"], update.io), 0, update.err());
    const file = JSON.parse(await readFile(baselines, "utf8")) as { entries: Array<{ name: string }> };
    assert.deepEqual(
      file.entries.map((entry) => entry.name),
      ["Menu"],
    );
  });
});

test("a passing check with --report-dir writes no diff artifacts", async () => {
  await withDirectory(async (dir) => {
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "menu.png"), solid(40));
    const baselines = join(dir, "baselines.json");
    assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm"], capture().io), 0);
    const reportDir = join(dir, "report");
    const run = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, frames, "--report-dir", reportDir], run.io), 0, run.err());
    assert.doesNotMatch(run.out(), /diff artifacts/);
    assert.ok(!(await readdir(dir)).includes("report"), "report dir must not be created on PASS");
  });
});
