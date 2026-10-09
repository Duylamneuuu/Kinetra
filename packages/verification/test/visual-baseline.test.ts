import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_BASELINE_HASH_TOLERANCE,
  VisualBaselineError,
  checkVisualBaselines,
  createVisualBaselineEntry,
  createVisualBaselineFile,
  encodePng,
  formatVisualBaselineReport,
  isCiEnvironment,
  loadVisualBaselineFile,
  parseVisualBaselineFile,
  saveVisualBaselineFile,
  serializeVisualBaselineFile,
  updateVisualBaselines,
  writeVisualBaselineArtifacts,
  type VisualBaselineFile,
  type VisualFrame,
} from "../src/index.js";

function solid(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set(rgba, i * 4);
  }
  return encodePng({ width, height, data });
}

/** Left half dark, right half bright: a strong horizontal gradient the dHash can see. */
function halves(width: number, height: number, flip = false): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = x < width / 2;
      const value = left !== flip ? 20 : 235;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, data });
}

/** Deterministic noise-free gradient so dHash bits are stable. */
function ramp(width: number, height: number, tweak = 0): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.min(255, Math.floor((x / width) * 200) + 20 + (x === 0 ? tweak : 0));
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, data });
}

function baselineFor(frames: VisualFrame[]): VisualBaselineFile {
  return {
    schemaVersion: 1,
    entries: frames.map((frame) => createVisualBaselineEntry(frame.name, frame.bytes)),
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof VisualBaselineError && error.code === code, `expected ${code}`);
}

test("entries record sha256, dHash and dimensions, and reject unsafe names", () => {
  const entry = createVisualBaselineEntry("arena-start", ramp(64, 32));
  assert.equal(entry.name, "arena-start");
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.match(entry.perceptualHash, /^[0-9a-f]{16}$/);
  assert.deepEqual([entry.width, entry.height], [64, 32]);
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "-lead", ".hidden", "x".repeat(129), "sp ace"]) {
    expectCode(() => createVisualBaselineEntry(bad, ramp(8, 8)), "baseline.invalidName");
  }
});

test("serialisation is canonical and round-trips; entries sort by code unit", () => {
  const frames: VisualFrame[] = [
    { name: "b", bytes: ramp(32, 16) },
    { name: "B", bytes: halves(32, 16) },
    { name: "a", bytes: solid(8, 8, [10, 20, 30, 255]) },
  ];
  const file = baselineFor(frames);
  const text = serializeVisualBaselineFile(file);
  assert.ok(text.endsWith("\n"));
  const parsed = parseVisualBaselineFile(text);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.name),
    ["B", "a", "b"],
  );
  assert.equal(serializeVisualBaselineFile(parsed), text);
  // Input order must not matter.
  assert.equal(serializeVisualBaselineFile({ ...file, entries: [...file.entries].reverse() }), text);
});

test("parse rejects malformed baseline files with structured errors", () => {
  const good = JSON.parse(serializeVisualBaselineFile(baselineFor([{ name: "a", bytes: ramp(16, 16) }]))) as {
    schemaVersion: number;
    entries: Array<Record<string, unknown>>;
  };
  const mutate = (change: (value: typeof good) => void): string => {
    const copy = JSON.parse(JSON.stringify(good)) as typeof good;
    change(copy);
    return JSON.stringify(copy);
  };
  expectCode(() => parseVisualBaselineFile("{"), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile("null"), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile("[]"), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.schemaVersion = 2))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => ((v as unknown as { entries: unknown }).entries = {}))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.entries[0]!.name = "../evil"))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.entries[0]!.sha256 = "abc"))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.entries[0]!.sha256 = "A".repeat(64)))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.entries[0]!.perceptualHash = "zzzzzzzzzzzzzzzz"))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.entries[0]!.width = 0))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.entries[0]!.height = 1.5))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => v.entries.push({ ...v.entries[0]! }))), "baseline.invalidFile");
  expectCode(() => parseVisualBaselineFile(mutate((v) => (v.entries[0] = 5 as unknown as Record<string, unknown>))), "baseline.invalidFile");
});

test("check: identical, similar, mismatch and missing are told apart", () => {
  const stable = ramp(64, 32);
  const baseline = baselineFor([
    { name: "stable", bytes: stable },
    { name: "drift", bytes: ramp(64, 32) },
    { name: "changed", bytes: halves(64, 32) },
    { name: "resized", bytes: ramp(64, 32) },
    { name: "unused", bytes: ramp(16, 16) },
  ]);
  const report = checkVisualBaselines(baseline, [
    { name: "stable", bytes: stable },
    { name: "drift", bytes: ramp(64, 32, 1) },
    { name: "changed", bytes: halves(64, 32, true) },
    { name: "resized", bytes: ramp(128, 64) },
    { name: "fresh", bytes: ramp(8, 8) },
  ]);
  const byName = new Map(report.results.map((result) => [result.name, result] as const));
  assert.equal(byName.get("stable")?.status, "identical");
  assert.equal(byName.get("stable")?.hashDistance, 0);
  assert.equal(byName.get("drift")?.status, "similar");
  assert.equal(byName.get("drift")?.passed, true);
  assert.equal(byName.get("changed")?.status, "mismatch");
  assert.ok((byName.get("changed")?.hashDistance ?? 0) > DEFAULT_BASELINE_HASH_TOLERANCE);
  assert.equal(byName.get("resized")?.status, "mismatch");
  assert.match(byName.get("resized")!.reasons.join(" "), /size changed from 64x32 to 128x64/);
  assert.equal(byName.get("fresh")?.status, "missing");
  assert.equal(byName.get("fresh")?.passed, false);
  assert.equal(report.passed, false);
  assert.deepEqual(report.unusedBaselines, ["unused"]);
  assert.deepEqual(
    report.results.map((result) => result.name),
    ["changed", "drift", "fresh", "resized", "stable"],
  );
});

test("check: a fully matching run passes and unused baselines never fail it", () => {
  const frame = { name: "only", bytes: ramp(32, 32) };
  const baseline = baselineFor([frame, { name: "elsewhere", bytes: halves(16, 16) }]);
  const report = checkVisualBaselines(baseline, [frame]);
  assert.equal(report.passed, true);
  assert.deepEqual(report.unusedBaselines, ["elsewhere"]);
  assert.equal(checkVisualBaselines(baseline, []).passed, true);
});

test("check: tolerance is validated and honoured, and never mutates the baseline", () => {
  const baseline = baselineFor([{ name: "a", bytes: halves(64, 32) }]);
  const before = serializeVisualBaselineFile(baseline);
  const frames: VisualFrame[] = [{ name: "a", bytes: halves(64, 32, true) }];
  assert.equal(checkVisualBaselines(baseline, frames).passed, false);
  assert.equal(checkVisualBaselines(baseline, frames, { maxPerceptualHashDistance: 64 }).passed, true);
  for (const bad of [-1, 65, Number.NaN, Number.POSITIVE_INFINITY, "8" as unknown as number]) {
    expectCode(() => checkVisualBaselines(baseline, frames, { maxPerceptualHashDistance: bad }), "baseline.invalidOption");
  }
  assert.equal(serializeVisualBaselineFile(baseline), before);
});

test("check: duplicate and badly named frames are rejected, not silently merged", () => {
  const baseline = createVisualBaselineFile();
  const frame = { name: "a", bytes: ramp(8, 8) };
  expectCode(() => checkVisualBaselines(baseline, [frame, frame]), "baseline.duplicateFrame");
  expectCode(() => checkVisualBaselines(baseline, [{ name: "../a", bytes: frame.bytes }]), "baseline.invalidName");
});

test("isCiEnvironment recognises CI markers and ignores falsy values", () => {
  assert.equal(isCiEnvironment({}), false);
  assert.equal(isCiEnvironment({ CI: "" }), false);
  assert.equal(isCiEnvironment({ CI: "0" }), false);
  assert.equal(isCiEnvironment({ CI: "false" }), false);
  assert.equal(isCiEnvironment({ CI: " FALSE " }), false);
  assert.equal(isCiEnvironment({ CI: "true" }), true);
  assert.equal(isCiEnvironment({ CI: "1" }), true);
  assert.equal(isCiEnvironment({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(isCiEnvironment({ GITHUB_ACTIONS: "false" }), false);
});

test("update needs explicit confirmation and refuses under CI", () => {
  const baseline = createVisualBaselineFile();
  const frames: VisualFrame[] = [{ name: "a", bytes: ramp(8, 8) }];
  expectCode(() => updateVisualBaselines(baseline, frames, { confirm: false, env: {} }), "baseline.updateNotConfirmed");
  expectCode(
    () => updateVisualBaselines(baseline, frames, { confirm: "yes" as unknown as boolean, env: {} }),
    "baseline.updateNotConfirmed",
  );
  expectCode(() => updateVisualBaselines(baseline, frames, { confirm: true, env: { CI: "true" } }), "baseline.updateForbiddenInCi");
  expectCode(
    () => updateVisualBaselines(baseline, frames, { confirm: true, env: { GITHUB_ACTIONS: "true" } }),
    "baseline.updateForbiddenInCi",
  );
  assert.equal(baseline.entries.length, 0);
});

test("update adds, replaces and keeps entries without mutating the input", () => {
  const original = baselineFor([
    { name: "keep", bytes: ramp(32, 16) },
    { name: "same", bytes: halves(32, 16) },
    { name: "stale", bytes: ramp(32, 16) },
  ]);
  const snapshot = serializeVisualBaselineFile(original);
  const result = updateVisualBaselines(
    original,
    [
      { name: "same", bytes: halves(32, 16) },
      { name: "stale", bytes: halves(32, 16, true) },
      { name: "new", bytes: solid(8, 8, [1, 2, 3, 255]) },
    ],
    { confirm: true, env: {} },
  );
  assert.deepEqual(result.added, ["new"]);
  assert.deepEqual(result.updated, ["stale"]);
  assert.deepEqual(result.unchanged, ["same"]);
  assert.deepEqual(
    result.file.entries.map((entry) => entry.name),
    ["keep", "new", "same", "stale"],
  );
  assert.equal(serializeVisualBaselineFile(original), snapshot);
  // After an update, the same frames pass an exact check.
  const report = checkVisualBaselines(result.file, [
    { name: "stale", bytes: halves(32, 16, true) },
    { name: "new", bytes: solid(8, 8, [1, 2, 3, 255]) },
  ]);
  assert.equal(report.passed, true);
  assert.ok(report.results.every((entry) => entry.status === "identical"));
});

test("update with `only` touches just the named frames and validates the names", () => {
  const original = baselineFor([{ name: "a", bytes: ramp(32, 16) }]);
  const frames: VisualFrame[] = [
    { name: "a", bytes: halves(32, 16) },
    { name: "b", bytes: halves(32, 16, true) },
  ];
  const result = updateVisualBaselines(original, frames, { confirm: true, env: {}, only: ["b"] });
  assert.deepEqual(result.added, ["b"]);
  assert.deepEqual(result.updated, []);
  assert.equal(result.file.entries.find((entry) => entry.name === "a")?.sha256, original.entries[0]!.sha256);
  expectCode(() => updateVisualBaselines(original, frames, { confirm: true, env: {}, only: ["zzz"] }), "baseline.invalidOption");
  expectCode(() => updateVisualBaselines(original, frames, { confirm: true, env: {}, only: ["../x"] }), "baseline.invalidName");
});

test("report text is deterministic and lists failures", () => {
  const baseline = baselineFor([{ name: "a", bytes: halves(32, 16) }]);
  const frames: VisualFrame[] = [
    { name: "a", bytes: halves(32, 16, true) },
    { name: "b", bytes: ramp(8, 8) },
  ];
  const first = formatVisualBaselineReport(checkVisualBaselines(baseline, frames));
  const second = formatVisualBaselineReport(checkVisualBaselines(baseline, frames));
  assert.equal(first, second);
  assert.match(first, /^# Visual baseline report: FAIL/);
  assert.match(first, /\| a \| mismatch \|/);
  assert.match(first, /\| b \| missing \| n\/a \| none \|/);
  assert.match(first, /- a: perceptual hash distance \d+ exceeds tolerance 8/);
  assert.match(formatVisualBaselineReport(checkVisualBaselines(baseline, [frames[0]!].slice(0, 0))), /PASS/);
});

test("file helpers: missing file is an empty baseline, save is atomic, artifacts hold only failing frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-baseline-"));
  try {
    const path = join(dir, "baselines.json");
    assert.deepEqual(await loadVisualBaselineFile(path), createVisualBaselineFile());

    const frames: VisualFrame[] = [
      { name: "good", bytes: ramp(32, 16) },
      { name: "bad", bytes: halves(32, 16) },
    ];
    const baseline = baselineFor(frames);
    await saveVisualBaselineFile(path, baseline);
    assert.deepEqual(await readdir(dir), ["baselines.json"], "no temp file is left behind");
    assert.equal(await readFile(path, "utf8"), serializeVisualBaselineFile(baseline));
    assert.deepEqual(await loadVisualBaselineFile(path), parseVisualBaselineFile(serializeVisualBaselineFile(baseline)));

    const report = checkVisualBaselines(baseline, [frames[0]!, { name: "bad", bytes: halves(32, 16, true) }]);
    assert.equal(report.passed, false);
    const out = join(dir, "artifacts");
    const written = await writeVisualBaselineArtifacts(out, report, [
      frames[0]!,
      { name: "bad", bytes: halves(32, 16, true) },
    ]);
    assert.deepEqual(
      written.map((file) => file.slice(out.length + 1)),
      ["report.json", "report.md", join("actual", "bad.png")],
    );
    assert.deepEqual(JSON.parse(await readFile(join(out, "report.json"), "utf8")), JSON.parse(JSON.stringify(report)));
    assert.deepEqual(await readdir(join(out, "actual")), ["bad.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file helpers surface structured errors for corrupt files and unwritable paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinetra-baseline-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const corrupt = join(dir, "corrupt.json");
    await writeFile(corrupt, "{ nope", "utf8");
    await assert.rejects(loadVisualBaselineFile(corrupt), (error: unknown) => error instanceof VisualBaselineError && error.code === "baseline.invalidFile");
    // A directory path cannot be read as a file.
    await assert.rejects(loadVisualBaselineFile(dir), (error: unknown) => error instanceof VisualBaselineError && error.code === "baseline.ioFailed");
    await assert.rejects(
      saveVisualBaselineFile(join(dir, "missing-dir", "b.json"), createVisualBaselineFile()),
      (error: unknown) => error instanceof VisualBaselineError && error.code === "baseline.ioFailed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("property: random frame sets round-trip through update -> serialise -> parse -> check", () => {
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let round = 0; round < 25; round++) {
    const count = 1 + Math.floor(next() * 5);
    const frames: VisualFrame[] = [];
    for (let i = 0; i < count; i++) {
      const w = 8 + Math.floor(next() * 40);
      const h = 8 + Math.floor(next() * 24);
      const data = new Uint8Array(w * h * 4);
      for (let p = 0; p < w * h; p++) {
        const v = Math.floor(next() * 256);
        data.set([v, (v * 7) & 255, (v * 13) & 255, 255], p * 4);
      }
      frames.push({ name: `frame-${round}-${i}`, bytes: encodePng({ width: w, height: h, data }) });
    }
    const updated = updateVisualBaselines(createVisualBaselineFile(), frames, { confirm: true, env: {} });
    const reparsed = parseVisualBaselineFile(serializeVisualBaselineFile(updated.file));
    const report = checkVisualBaselines(reparsed, [...frames].reverse());
    assert.equal(report.passed, true, `round ${round}`);
    assert.ok(report.results.every((result) => result.status === "identical"));
    assert.deepEqual(report.unusedBaselines, []);
  }
});
