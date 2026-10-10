import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  const dir = await mkdtemp(join(tmpdir(), "kinetra-baseline-cli-edges-"));
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

async function seededBaseline(dir: string): Promise<string> {
  const frames = join(dir, "seed");
  await mkdir(frames);
  await writeFile(join(frames, "menu.png"), solid(40));
  const baselines = join(dir, "baselines.json");
  assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm"], capture().io), 0);
  return baselines;
}

test("check against an empty frames directory is an error, not a silent PASS", async () => {
  await withDirectory(async (dir) => {
    const baselines = await seededBaseline(dir);
    const empty = join(dir, "empty");
    await mkdir(empty);
    const run = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, empty], run.io), 2);
    assert.match(run.err(), /baseline\.noFrames/);
    assert.doesNotMatch(run.out(), /PASS/);
  });
});

test("check with no baseline file and no frames is an error too", async () => {
  await withDirectory(async (dir) => {
    const empty = join(dir, "empty");
    await mkdir(empty);
    const run = capture();
    assert.equal(await runVisualBaselineCli(["check", join(dir, "missing.json"), empty], run.io), 2);
    assert.match(run.err(), /baseline\.noFrames/);
  });
});

test("update with no frames does not rewrite the baseline file", async () => {
  await withDirectory(async (dir) => {
    const baselines = await seededBaseline(dir);
    const before = await readFile(baselines, "utf8");
    const empty = join(dir, "empty");
    await mkdir(empty);
    const run = capture();
    assert.equal(await runVisualBaselineCli(["update", baselines, empty, "--confirm"], run.io), 2);
    assert.equal(await readFile(baselines, "utf8"), before);
  });
});

test("a corrupt PNG is reported as exit 2 instead of an uncaught exception", async () => {
  await withDirectory(async (dir) => {
    const baselines = await seededBaseline(dir);
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "menu.png"), "definitely not a png");
    const run = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, frames], run.io), 2);
    assert.match(run.err(), /visual\.decodeFailed/);
  });
});

test("a directory named *.png is skipped rather than crashing the read", async () => {
  await withDirectory(async (dir) => {
    const baselines = await seededBaseline(dir);
    const frames = join(dir, "frames");
    await mkdir(join(frames, "junk.png"), { recursive: true });
    await writeFile(join(frames, "menu.png"), solid(40));
    const run = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, frames], run.io), 0);
    assert.match(run.out(), /PASS/);
    assert.doesNotMatch(run.out(), /junk/);
  });
});

test("a symlink to a directory named *.png is skipped too", async (t) => {
  await withDirectory(async (dir) => {
    const baselines = await seededBaseline(dir);
    const frames = join(dir, "frames");
    await mkdir(join(dir, "target-dir"), { recursive: true });
    await mkdir(frames);
    try {
      await symlink(join(dir, "target-dir"), join(frames, "link.png"), "dir");
    } catch {
      t.skip("cannot create symlinks on this platform");
      return;
    }
    await writeFile(join(frames, "menu.png"), solid(40));
    const run = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, frames], run.io), 0);
    assert.doesNotMatch(run.out(), /link/);
  });
});

test("--only with no names is a usage error and leaves the baseline alone", async () => {
  await withDirectory(async (dir) => {
    const baselines = await seededBaseline(dir);
    const before = await readFile(baselines, "utf8");
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "menu.png"), solid(200));
    const run = capture();
    assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm", "--only", ","], run.io), 2);
    assert.match(run.err(), /--only needs at least one frame name/);
    assert.equal(await readFile(baselines, "utf8"), before);
  });
});
