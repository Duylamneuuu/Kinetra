import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { RuntimeProbe } from "@kinetra/verification";

import { OrbRunHeadlessProbe } from "../src/index.js";
import {
  ORB_RUN_MANIFEST_SUFFIX,
  formatOrbRunSuiteReport,
  orbRunAcceptanceDirectory,
  runOrbRunAcceptanceSuite,
} from "../src/acceptance-suite.js";

const run = promisify(execFile);
const ACCEPTANCE = orbRunAcceptanceDirectory();
const CLI = fileURLToPath(new URL("../src/acceptance-cli.js", import.meta.url));

async function shippedManifestFiles(): Promise<string[]> {
  return (await readdir(ACCEPTANCE)).filter((name) => name.endsWith(ORB_RUN_MANIFEST_SUFFIX)).sort();
}

async function withTempDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "orb-run-suite-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The shipped win manifest with one assertion made false. */
async function brokenWinManifest(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(ACCEPTANCE, "win.acceptance.json"), "utf8")) as {
    suite: string;
    steps: Array<Record<string, unknown>>;
  };
  const target = manifest.steps.find((step) => step.type === "assert.equal" && step.path === "state.game.totalOrbs");
  assert.ok(target, "the win manifest asserts the orb total");
  target.expected = 4;
  manifest.suite = "orb-run.broken-win";
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

test("every shipped acceptance manifest passes in one suite run", async () => {
  const files = await shippedManifestFiles();
  const report = await runOrbRunAcceptanceSuite();
  assert.deepEqual(
    report.entries.map((entry) => entry.file),
    files,
    "the suite covers exactly the manifests on disk, sorted",
  );
  assert.equal(report.passed, true, formatOrbRunSuiteReport(report));
  assert.equal(report.total, files.length);
  assert.equal(report.failed, 0);
  for (const entry of report.entries) {
    assert.ok(entry.steps > 0, `${entry.file} has steps`);
    assert.equal(entry.passedSteps, entry.steps, `${entry.file} ran every step green`);
    assert.equal(entry.failure, undefined);
    assert.equal(entry.error, undefined);
  }
});

test("the suite keeps the known manifests (a deleted contract is a failing test, not a silent drop)", async () => {
  const files = await shippedManifestFiles();
  for (const name of [
    "win",
    "timeout",
    "save-load",
    "audio",
    "hud",
    "hud-timeout",
    "animation",
    "assets",
    "replay-win",
    "replay-timeout",
  ]) {
    assert.ok(files.includes(`${name}${ORB_RUN_MANIFEST_SUFFIX}`), `${name} manifest is shipped`);
  }
});

test("every golden replay has its generated manifest next to it", async () => {
  const files = new Set(await shippedManifestFiles());
  const replays = (await readdir(join(ACCEPTANCE, "replays"))).filter((name) => name.endsWith(".replay.json"));
  assert.ok(replays.length >= 2);
  for (const replay of replays) {
    const name = replay.slice(0, -".replay.json".length);
    assert.ok(files.has(`replay-${name}${ORB_RUN_MANIFEST_SUFFIX}`), `replay-${name} manifest exists`);
  }
});

test("a manifest whose assertion is false fails the suite and names the failed step", async () => {
  await withTempDirectory(async (directory) => {
    await copyFile(join(ACCEPTANCE, "timeout.acceptance.json"), join(directory, "timeout.acceptance.json"));
    await writeFile(join(directory, "broken.acceptance.json"), await brokenWinManifest(), "utf8");
    const report = await runOrbRunAcceptanceSuite(directory);
    assert.equal(report.passed, false);
    assert.equal(report.total, 2);
    assert.equal(report.failed, 1);
    const [broken, timeout] = report.entries;
    assert.equal(broken?.file, "broken.acceptance.json");
    assert.equal(broken?.suite, "orb-run.broken-win");
    assert.equal(broken?.passed, false);
    assert.equal(broken?.error, undefined, "the game failed, not the file");
    assert.equal(broken?.failure?.type, "assert.equal");
    assert.match(broken?.failure?.message ?? "", /totalOrbs|4|3/);
    assert.ok((broken?.passedSteps ?? 0) < (broken?.steps ?? 0));
    assert.equal(timeout?.passed, true, "one failure does not hide the other manifest");
  });
});

test("unusable manifest files become structured failures instead of crashing the suite", async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, "a-not-json.acceptance.json"), "{ nope", "utf8");
    await writeFile(
      join(directory, "b-wrong-shape.acceptance.json"),
      JSON.stringify({ schemaVersion: 1, suite: "x", steps: [{ type: "no.such.step" }] }),
      "utf8",
    );
    await writeFile(join(directory, "c-ignored.json"), "{ not a manifest, wrong suffix }", "utf8");
    await mkdir(join(directory, "replays"));
    await writeFile(join(directory, "replays", "d.acceptance.json"), "{ nested files are not manifests }", "utf8");
    await copyFile(join(ACCEPTANCE, "win.acceptance.json"), join(directory, "e-win.acceptance.json"));

    const report = await runOrbRunAcceptanceSuite(directory);
    assert.deepEqual(
      report.entries.map((entry) => [entry.file, entry.passed, entry.error?.code]),
      [
        ["a-not-json.acceptance.json", false, "invalid_json"],
        ["b-wrong-shape.acceptance.json", false, "invalid_manifest"],
        ["e-win.acceptance.json", true, undefined],
      ],
    );
    assert.equal(report.failed, 2);
    assert.equal(report.passed, false);
    assert.equal(report.entries[0]?.suite, "a-not-json", "an unparsable file is named after its file");
  });
});

test("an empty or missing directory fails instead of passing vacuously", async () => {
  await withTempDirectory(async (directory) => {
    const empty = await runOrbRunAcceptanceSuite(directory);
    assert.equal(empty.passed, false);
    assert.equal(empty.entries[0]?.error?.code, "no_manifests");

    const missing = await runOrbRunAcceptanceSuite(join(directory, "does-not-exist"));
    assert.equal(missing.passed, false);
    assert.equal(missing.entries[0]?.error?.code, "unreadable");
  });
});

test("each manifest gets a fresh probe, and a probe that throws outside a step is reported", async () => {
  await withTempDirectory(async (directory) => {
    await copyFile(join(ACCEPTANCE, "win.acceptance.json"), join(directory, "a.acceptance.json"));
    await copyFile(join(ACCEPTANCE, "win.acceptance.json"), join(directory, "b.acceptance.json"));
    const probes: OrbRunHeadlessProbe[] = [];
    const report = await runOrbRunAcceptanceSuite(directory, {
      probeFactory: () => {
        const probe = new OrbRunHeadlessProbe();
        probes.push(probe);
        return probe;
      },
    });
    assert.equal(report.passed, true, formatOrbRunSuiteReport(report));
    assert.equal(probes.length, 2);
    assert.notEqual(probes[0], probes[1]);

    const exploding = await runOrbRunAcceptanceSuite(directory, {
      probeFactory: () => {
        throw new Error("probe factory exploded");
      },
    });
    assert.equal(exploding.passed, false);
    assert.deepEqual(
      exploding.entries.map((entry) => entry.error?.code),
      ["probe_threw", "probe_threw"],
    );
    assert.match(exploding.entries[0]?.error?.message ?? "", /exploded/);

    // A probe that is not even a RuntimeProbe: the runner's own error is surfaced, never swallowed into a pass.
    const hollow = await runOrbRunAcceptanceSuite(directory, { probeFactory: () => ({}) as RuntimeProbe });
    assert.equal(hollow.passed, false);
  });
});

test("the text report is pinned: one line per manifest, then a verdict", async () => {
  await withTempDirectory(async (directory) => {
    await copyFile(join(ACCEPTANCE, "timeout.acceptance.json"), join(directory, "timeout.acceptance.json"));
    await writeFile(join(directory, "broken.acceptance.json"), await brokenWinManifest(), "utf8");
    await writeFile(join(directory, "junk.acceptance.json"), "[", "utf8");
    const lines = formatOrbRunSuiteReport(await runOrbRunAcceptanceSuite(directory)).split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0] ?? "", /^FAIL broken\.acceptance\.json \(\d+\/\d+ steps\): step \d+ \(assert\.equal\): /);
    assert.match(lines[1] ?? "", /^FAIL junk\.acceptance\.json \(0\/0 steps\): invalid_json: /);
    assert.match(lines[2] ?? "", /^PASS timeout\.acceptance\.json \(\d+\/\d+ steps\)$/);
    assert.equal(lines[3], "orb-run acceptance: 2 of 3 failed");

    const all = formatOrbRunSuiteReport(await runOrbRunAcceptanceSuite());
    assert.match(all.split("\n").at(-1) ?? "", /^orb-run acceptance: \d+ manifests passed$/);
  });
});

test("the CLI exits 0 on the shipped suite, 1 on a failing manifest, 2 on bad arguments", async () => {
  const ok = await run(process.execPath, [CLI]);
  assert.match(ok.stdout, /orb-run acceptance: \d+ manifests passed/);

  const json = await run(process.execPath, [CLI, "--json"]);
  const parsed = JSON.parse(json.stdout) as { passed: boolean; total: number; entries: unknown[] };
  assert.equal(parsed.passed, true);
  assert.equal(parsed.entries.length, parsed.total);

  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, "broken.acceptance.json"), await brokenWinManifest(), "utf8");
    await assert.rejects(run(process.execPath, [CLI, directory]), (error: { code?: number; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout ?? "", /FAIL broken\.acceptance\.json/);
      return true;
    });
    await assert.rejects(run(process.execPath, [CLI, "--json", directory]), (error: { code?: number; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.equal((JSON.parse(error.stdout ?? "{}") as { passed?: boolean }).passed, false);
      return true;
    });
  });

  await assert.rejects(run(process.execPath, [CLI, "--bogus"]), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr ?? "", /usage/);
    return true;
  });
});
