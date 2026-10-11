import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkVisualBaselines,
  createVisualBaselineEntry,
  createVisualBaselineFile,
  encodePng,
  loadVisualBaselineFile,
  saveVisualBaselineFile,
  writeVisualBaselineArtifacts,
  type VisualBaselineFile,
} from "../src/index.js";

function solid(value: number): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) data.set([value, value, value, 255], i * 4);
  return encodePng({ width: 16, height: 16, data });
}

/** Left dark, right bright: the dHash sees it, a solid frame hashes to zero. */
function halves(flip: boolean): Uint8Array {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const value = x < 16 !== flip ? 20 : 235;
      data.set([value, value, value, 255], (y * 32 + x) * 4);
    }
  }
  return encodePng({ width: 32, height: 32, data });
}

test("artifacts of a later run do not keep the PNGs of frames that failed in an earlier run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-baseline-io-"));
  try {
    const goodBytes = halves(false);
    const baseline: VisualBaselineFile = {
      schemaVersion: 1,
      entries: [createVisualBaselineEntry("hero", goodBytes)],
    };

    // Run 1: the frame regressed (flipped), its PNG is written for a human to inspect.
    const run1 = [{ name: "hero", bytes: halves(true) }];
    const report1 = checkVisualBaselines(baseline, run1);
    assert.equal(report1.passed, false);
    await writeVisualBaselineArtifacts(dir, report1, run1);
    assert.deepEqual(await readdir(join(dir, "actual")), ["hero.png"]);

    // Run 2: the regression is fixed. The artifact directory must describe run 2 only.
    const run2 = [{ name: "hero", bytes: goodBytes }];
    const report2 = checkVisualBaselines(baseline, run2);
    assert.equal(report2.passed, true);
    const written = await writeVisualBaselineArtifacts(dir, report2, run2);
    assert.deepEqual(await readdir(join(dir, "actual")), [], "stale hero.png from run 1 must be gone");
    assert.deepEqual(
      written.map((path) => path.slice(dir.length + 1)),
      ["report.json", "report.md"],
    );
    assert.equal(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).passed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent saves of the same baseline path both succeed and leave a valid file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-baseline-io-"));
  try {
    const path = join(dir, "baseline.json");
    const a: VisualBaselineFile = { schemaVersion: 1, entries: [createVisualBaselineEntry("a", solid(10))] };
    const b: VisualBaselineFile = { schemaVersion: 1, entries: [createVisualBaselineEntry("b", solid(200))] };
    await Promise.all([saveVisualBaselineFile(path, a), saveVisualBaselineFile(path, b)]);
    const loaded = await loadVisualBaselineFile(path);
    assert.equal(loaded.entries.length, 1);
    assert.ok(["a", "b"].includes(loaded.entries[0]!.name));
    // No temp file is left behind.
    assert.deepEqual(await readdir(dir), ["baseline.json"]);
    // The empty file stays loadable too.
    await saveVisualBaselineFile(path, createVisualBaselineFile());
    assert.deepEqual((await loadVisualBaselineFile(path)).entries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
