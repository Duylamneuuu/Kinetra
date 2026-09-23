/**
 * Linux cloud runtime smoke for the real Electron player.
 *
 * Proves, against real Electron under xvfb with software rendering:
 * ping, runtime.hostInfo (linux), runtime.start, runtime.query, runtime.step,
 * runtime.injectInput, runtime.captureFrame (valid PNG), runtime.stop, plus
 * clean teardown with no leaked Electron processes across repeated runs.
 *
 * Verification level: LINUX CLOUD (real Electron, dev build). This is fast
 * development/runtime proof. It is NOT Windows packaging proof and NOT
 * packaged KinetraGame.exe proof; those remain Windows CI jobs.
 *
 * Usage:
 *   pnpm --filter @kinetra/player build
 *   pnpm --filter @kinetra/player smoke:linux [--out-dir <dir>] [--iterations <n>]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "..", "..");
const defaultOutDir = join(appRoot, "dist", "linux-smoke");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_PNG_BYTES = 1_000;
const OVERALL_TIMEOUT_MS = 240_000;

function parseArgs(argv) {
  const args = { outDir: defaultOutDir, iterations: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out-dir" && argv[i + 1]) {
      args.outDir = resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--iterations" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        throw new Error("--iterations must be an integer in [1, 10]");
      }
      args.iterations = n;
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: smoke-linux.mjs [--out-dir <dir>] [--iterations <n>]",
      );
      process.exit(0);
    } else {
      throw new Error(
        `Unknown argument "${argv[i]}". Usage: smoke-linux.mjs [--out-dir <dir>] [--iterations <n>]`,
      );
    }
  }
  return args;
}

function fail(message, hint) {
  console.error(`LINUX SMOKE FAIL: ${message}`);
  if (hint) {
    console.error(`hint: ${hint}`);
  }
  process.exit(1);
}

function ensureLinux() {
  if (process.platform !== "linux") {
    fail(
      `smoke:linux runs on Linux only (current platform: ${process.platform}).`,
      process.platform === "win32"
        ? "Use pnpm --filter @kinetra/player smoke:win on Windows."
        : "Linux cloud verification is not supported on this platform.",
    );
  }
}

/** Re-exec under xvfb when no X display is available. Never returns. */
function ensureDisplay(scriptPath, passthrough) {
  if (process.env.DISPLAY || process.env.KINETRA_UNDER_XVFB) {
    return;
  }
  const probe = spawnSync("which", ["xvfb-run"], { encoding: "utf8" });
  if (probe.status !== 0) {
    fail(
      "No X display (DISPLAY is unset) and xvfb-run was not found.",
      "Install xvfb (apt-get install xvfb) or run under an X server.",
    );
  }
  console.log("No DISPLAY detected; re-executing under xvfb-run.");
  const rerun = spawnSync(
    "xvfb-run",
    [
      "-a",
      "--server-args=-screen 0 1280x720x24",
      process.execPath,
      scriptPath,
      ...passthrough,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, KINETRA_UNDER_XVFB: "1" },
    },
  );
  process.exit(rerun.status ?? 1);
}

/** PIDs of live Electron processes currently running this player entry. */
async function findPlayerProcesses(playerEntry) {
  const hits = [];
  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return hits;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (pid === process.pid) {
      continue;
    }
    let cmdline;
    try {
      cmdline = await readFile(`/proc/${name}/cmdline`);
    } catch {
      continue;
    }
    const parts = cmdline.toString("utf8").split("\0").filter(Boolean);
    if (
      parts.length >= 2 &&
      parts[0].includes("electron") &&
      parts.slice(1).some((arg) => arg.includes(playerEntry))
    ) {
      hits.push(pid);
    }
  }
  return hits;
}

function summarizeHostInfo(hostInfo) {
  return `platform=${hostInfo.platform} arch=${hostInfo.arch} packaged=${hostInfo.isPackaged}`;
}

async function runIteration({
  iteration,
  outDir,
  playerEntry,
  ElectronRuntimeHost,
  createArenaProject,
  arenaSceneId,
  arenaAudioAssets,
}) {
  const checks = [];
  const check = (name, fn) => {
    const started = Date.now();
    return Promise.resolve()
      .then(fn)
      .then((detail) => {
        checks.push({ name, passed: true, durationMs: Date.now() - started, detail });
        console.log(`  ok - ${name}`);
        return detail;
      })
      .catch((error) => {
        checks.push({
          name,
          passed: false,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  };

  // Linux sandbox/GPU switches are LINUX_ELECTRON_LAUNCH_ARGS inside
  // ElectronRuntimeHost. This script must not keep a second copy.
  const host = new ElectronRuntimeHost({
    transport: "stdio",
    requestTimeoutMs: 30_000,
  });
  let framePath;
  let frameSha256;
  let frameBytes = 0;
  let hostInfoSummary = "";

  try {
    await check("ping", async () => {
      const pong = await host.request("ping", {});
      if (!pong || pong.ready !== true) {
        throw new Error(`unexpected ping result ${JSON.stringify(pong)}`);
      }
      return "ready=true";
    });

    await check("runtime.hostInfo identifies Linux", async () => {
      const hostInfo = await host.getHostInfo();
      if (hostInfo.platform !== "linux") {
        throw new Error(`expected platform linux, got ${hostInfo.platform}`);
      }
      hostInfoSummary = summarizeHostInfo(hostInfo);
      return hostInfoSummary;
    });

    await check("runtime.start (Kinetra Arena)", async () => {
      await host.start(createArenaProject(), arenaSceneId, 0, arenaAudioAssets);
      return `scene=${arenaSceneId}`;
    });

    const before = await check("runtime.query exposes arena state", async () => {
      const query = await host.query();
      if (!query.running) {
        throw new Error("expected running=true after runtime.start");
      }
      const player = query.entities.find((entity) => entity.name === "Player");
      if (!player) {
        throw new Error("Player entity missing from runtime.query");
      }
      const [x, y, z] = player.position;
      if (x !== -5 || y !== 0.5 || z !== -5) {
        throw new Error(`unexpected Player spawn ${JSON.stringify(player.position)}`);
      }
      return `entities=${query.entities.length} player=[${x}, ${y}, ${z}]`;
    });
    void before;

    await check("runtime.step advances simulation", async () => {
      await host.step(2);
      return "steps=2";
    });

    await check("runtime.injectInput moves the player", async () => {
      await host.injectInput({ action: "player.moveRight", phase: "press", value: 1 });
      await host.step(1);
      const query = await host.query();
      const player = query.entities.find((entity) => entity.name === "Player");
      if (!player || player.position[0] !== -4) {
        throw new Error(
          `semantic input did not move the player (-5 -> -4); got ${JSON.stringify(player?.position)}`,
        );
      }
      return `player.x=-5 -> -4`;
    });

    await check("runtime.captureFrame produces a valid PNG", async () => {
      const capture = await host.captureFrame();
      if (!capture.available || !capture.base64) {
        throw new Error(capture.reason ?? "frame capture unavailable");
      }
      if (capture.mimeType !== "image/png") {
        throw new Error(`expected image/png, got ${capture.mimeType}`);
      }
      const png = Buffer.from(capture.base64, "base64");
      if (png.length < MIN_PNG_BYTES) {
        throw new Error(`PNG too small (${png.length} bytes)`);
      }
      if (!png.subarray(0, 8).equals(PNG_MAGIC)) {
        throw new Error("capture is not a valid PNG (bad magic bytes)");
      }
      frameBytes = png.length;
      frameSha256 = createHash("sha256").update(png).digest("hex");
      framePath = join(outDir, `frame-iter${iteration}.png`);
      await writeFile(framePath, png);
      return `bytes=${frameBytes} sha256=${frameSha256.slice(0, 16)}...`;
    });

    await check("runtime.readLogs observes structured events", async () => {
      const logs = await host.readLogs(0);
      if (!logs.some((entry) => entry.message === "runtime.started")) {
        throw new Error("missing runtime.started log entry");
      }
      const errors = logs.filter((entry) => entry.level === "error");
      if (errors.length > 0) {
        throw new Error(
          `unexpected error logs: ${errors.map((entry) => entry.message).join(", ")}`,
        );
      }
      return `entries=${logs.length} errors=0`;
    });

    await check("runtime.stop", async () => {
      await host.stop();
      return "stopped";
    });
  } finally {
    await host.close();
  }

  return { iteration, checks, framePath, frameSha256, frameBytes, hostInfoSummary };
}

async function main() {
  ensureLinux();
  const passthrough = process.argv.slice(2);
  ensureDisplay(fileURLToPath(import.meta.url), passthrough);
  const { outDir, iterations } = parseArgs(passthrough);

  const playerEntry = resolve(repoRoot, "apps/player/dist/package");
  if (!existsSync(join(playerEntry, "package.json"))) {
    fail(
      `Player build not found at ${playerEntry}.`,
      "Run pnpm --filter @kinetra/player build first.",
    );
  }
  const verificationEntry = resolve(repoRoot, "packages/verification/dist/src/index.js");
  if (!existsSync(verificationEntry)) {
    fail(
      `Verification build not found at ${verificationEntry}.`,
      "Run pnpm build first.",
    );
  }
  const referenceEntry = resolve(repoRoot, "examples/reference-game/dist/index.js");
  if (!existsSync(referenceEntry)) {
    fail(
      `Reference-game build not found at ${referenceEntry}.`,
      "Run pnpm build first.",
    );
  }

  let ElectronRuntimeHost;
  let createArenaProject;
  let arenaSceneId;
  let arenaAudioAssets;
  try {
    ({ ElectronRuntimeHost } = await import("@kinetra/verification"));
    ({
      createArenaProject,
      ARENA_SCENE_ID: arenaSceneId,
      arenaAudioAssets,
    } = await import("@kinetra/reference-game"));
  } catch (error) {
    fail(
      `Failed to load workspace runtime harness: ${error instanceof Error ? error.message : String(error)}`,
      "Run pnpm install && pnpm build first.",
    );
  }

  await mkdir(outDir, { recursive: true });

  // Show the bridge window: hidden windows yield DOM-stale capturePage()
  // frames, while under xvfb a shown window composites truthfully. This only
  // affects processes spawned by this smoke run.
  process.env.KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW = "1";

  const overallTimeout = setTimeout(() => {
    fail(
      `Timed out after ${OVERALL_TIMEOUT_MS}ms.`,
      "Check for a hung Electron process and rerun with --iterations 1.",
    );
  }, OVERALL_TIMEOUT_MS);
  overallTimeout.unref();

  const startedAt = new Date().toISOString();
  const suiteStarted = Date.now();
  console.log(`Linux runtime smoke: ${iterations} iteration(s), out=${outDir}`);

  const baseline = await findPlayerProcesses(playerEntry);
  const results = [];
  let failed = null;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    console.log(`iteration ${iteration}/${iterations}`);
    try {
      results.push(
        await runIteration({
          iteration,
          outDir,
          playerEntry,
          ElectronRuntimeHost,
          createArenaProject,
          arenaSceneId,
          arenaAudioAssets,
        }),
      );
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
      break;
    }
    // Brief settle so teardown races cannot hide a leaked process.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const leaked = (await findPlayerProcesses(playerEntry)).filter(
      (pid) => !baseline.includes(pid),
    );
    if (leaked.length > 0) {
      failed = `leaked Electron player process(es) after iteration ${iteration}: ${leaked.join(", ")}`;
      break;
    }
  }

  const leakedAfter = failed
    ? []
    : (await findPlayerProcesses(playerEntry)).filter((pid) => !baseline.includes(pid));
  const passed = !failed && leakedAfter.length === 0;
  if (leakedAfter.length > 0) {
    failed = `leaked Electron player process(es): ${leakedAfter.join(", ")}`;
  }

  const report = {
    suite: "linux-player-smoke",
    proofLevel: "LINUX CLOUD (real Electron, dev build, stdio bridge)",
    platform: process.platform,
    arch: process.arch,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - suiteStarted,
    iterations: results,
    processLeakCheck: {
      baselinePlayerProcesses: baseline,
      leakedPlayerProcesses: leakedAfter,
      passed: leakedAfter.length === 0,
    },
    passed,
    ...(failed ? { failureReason: failed } : {}),
  };
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  if (!passed) {
    fail(failed ?? "unknown failure", `See ${join(outDir, "report.json")}.`);
  }
  const totalChecks = results.reduce((sum, result) => sum + result.checks.length, 0);
  console.log(
    `LINUX SMOKE PASS: ${iterations} iteration(s), ${totalChecks} check(s), no leaked processes.`,
  );
  console.log(`frames + report: ${outDir}`);
}

await main();
