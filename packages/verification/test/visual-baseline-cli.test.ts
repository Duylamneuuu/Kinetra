import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodePng, runVisualBaselineCli } from "../src/index.js";

function halves(flip: boolean): Uint8Array {
  const width = 64;
  const height = 32;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = x < width / 2 !== flip ? 20 : 235;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, data });
}

async function withDirectory(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-baseline-cli-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function capture(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { env, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

test("update then check: explicit update writes baselines, check passes and never rewrites them", async () => {
  await withDirectory(async (dir) => {
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "arena.png"), halves(false));
    await writeFile(join(frames, "notes.txt"), "ignored");
    const baselines = join(dir, "baselines.json");

    const update = capture();
    assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm"], update.io), 0);
    assert.match(update.out(), /1 added, 0 updated, 0 unchanged/);
    const written = await readFile(baselines, "utf8");
    assert.match(written, /"name": "arena"/);

    const check = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, frames], check.io), 0);
    assert.match(check.out(), /PASS/);
    assert.equal(await readFile(baselines, "utf8"), written);
  });
});

test("check fails with exit 1 on regression, writes artifacts, and leaves baselines untouched", async () => {
  await withDirectory(async (dir) => {
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "arena.png"), halves(false));
    const baselines = join(dir, "baselines.json");
    assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm"], capture().io), 0);
    const before = await readFile(baselines, "utf8");

    await writeFile(join(frames, "arena.png"), halves(true));
    await writeFile(join(frames, "brand-new.png"), halves(false));
    const reportDir = join(dir, "report");
    const check = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, frames, "--report-dir", reportDir], check.io), 1);
    assert.match(check.out(), /FAIL/);
    assert.match(check.out(), /brand-new/);
    assert.deepEqual((await readdir(join(reportDir, "actual"))).sort(), ["arena.png", "brand-new.png"]);
    assert.equal(await readFile(baselines, "utf8"), before);

    // A generous tolerance lets the changed frame through, but the new frame still has no baseline.
    const lenient = capture();
    assert.equal(await runVisualBaselineCli(["check", baselines, frames, "--tolerance", "64"], lenient.io), 1);
    assert.doesNotMatch(lenient.out(), /\| arena \| mismatch/);
  });
});

test("update refuses under CI and without --confirm, leaving no baseline file behind", async () => {
  await withDirectory(async (dir) => {
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "arena.png"), halves(false));
    const baselines = join(dir, "baselines.json");

    const ci = capture({ CI: "true" });
    assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm"], ci.io), 2);
    assert.match(ci.err(), /baseline\.updateForbiddenInCi/);

    const unconfirmed = capture();
    assert.equal(await runVisualBaselineCli(["update", baselines, frames], unconfirmed.io), 2);
    assert.match(unconfirmed.err(), /baseline\.updateNotConfirmed/);

    assert.deepEqual(await readdir(dir), ["frames"]);
  });
});

test("update --only touches just the named frame", async () => {
  await withDirectory(async (dir) => {
    const frames = join(dir, "frames");
    await mkdir(frames);
    await writeFile(join(frames, "a.png"), halves(false));
    await writeFile(join(frames, "b.png"), halves(true));
    const baselines = join(dir, "baselines.json");
    const run = capture();
    assert.equal(await runVisualBaselineCli(["update", baselines, frames, "--confirm", "--only", "b"], run.io), 0);
    const file = JSON.parse(await readFile(baselines, "utf8")) as { entries: Array<{ name: string }> };
    assert.deepEqual(
      file.entries.map((entry) => entry.name),
      ["b"],
    );
  });
});

test("usage and IO problems exit 2 with a message", async () => {
  await withDirectory(async (dir) => {
    for (const args of [
      [],
      ["frobnicate", "a", "b"],
      ["check"],
      ["check", "only-one"],
      ["check", "a", "b", "--tolerance"],
      ["check", "a", "b", "--tolerance", "abc"],
      ["check", "a", "b", "--nope"],
    ]) {
      const run = capture();
      assert.equal(await runVisualBaselineCli(args, run.io), 2, JSON.stringify(args));
      assert.match(run.err(), /usage:/);
    }
    const missing = capture();
    assert.equal(await runVisualBaselineCli(["check", join(dir, "b.json"), join(dir, "nope")], missing.io), 2);
    assert.match(missing.err(), /ENOENT/);

    const bad = join(dir, "bad.json");
    await writeFile(bad, "{", "utf8");
    await mkdir(join(dir, "empty"));
    const corrupt = capture();
    assert.equal(await runVisualBaselineCli(["check", bad, join(dir, "empty")], corrupt.io), 2);
    assert.match(corrupt.err(), /baseline\.invalidFile/);

    const badTolerance = capture();
    await writeFile(join(dir, "ok.json"), '{"schemaVersion":1,"entries":[]}', "utf8");
    assert.equal(
      await runVisualBaselineCli(["check", join(dir, "ok.json"), join(dir, "empty"), "--tolerance", "99"], badTolerance.io),
      2,
    );
    assert.match(badTolerance.err(), /baseline\.invalidOption/);
  });
});
