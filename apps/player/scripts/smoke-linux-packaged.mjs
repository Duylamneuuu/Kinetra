import { spawn, spawnSync } from "node:child_process";
import { constants, readFileSync, readdirSync } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const exe = join(here, "..", "release", "KinetraGame-linux-x64", "KinetraGame");
const evidenceDir = join(here, "..", "dist", "linux-packaged-smoke");

if (process.platform !== "linux") {
  throw new Error("smoke:linux:packaged must run on Linux");
}

if (!process.env.DISPLAY) {
  const relaunch = spawnSync(
    "xvfb-run",
    ["-a", process.execPath, fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: process.env },
  );
  process.exit(relaunch.status ?? 1);
}

const { ElectronRuntimeHost, LINUX_ELECTRON_LAUNCH_ARGS } = await import(
  "../../../packages/verification/dist/src/electron-runtime.js"
);
const { createArenaProject, ARENA_SCENE_ID, arenaAudioAssets } = await import(
  "../../../examples/reference-game/dist/index.js"
);

await access(exe, constants.X_OK);
const binary = await stat(exe);
console.log("PACKAGED_LINUX_BINARY", exe);
console.log("PACKAGED_LINUX_BINARY_BYTES", String(binary.size));

await runBootSmoke();
assertNoPackagedProcesses("before bridge proof");

for (let iteration = 1; iteration <= 2; iteration += 1) {
  console.log(`Packaged Linux bridge iteration ${iteration}`);
  await runBridgeIteration(iteration);
  await waitForExit();
  assertNoPackagedProcesses(`after bridge iteration ${iteration}`);
}

const suites = [
  [
    "MCP packaged acceptance",
    join(repoRoot, "packages/mcp-server/dist/test/real-mcp-acceptance.test.js"),
  ],
  [
    "Arena",
    join(repoRoot, "packages/verification/dist/test/real-arena.test.js"),
  ],
  [
    "Game shell",
    join(repoRoot, "packages/verification/dist/test/real-game-shell.test.js"),
  ],
  [
    "Gameplay loop",
    join(repoRoot, "packages/verification/dist/test/real-gameplay-loop.test.js"),
  ],
  [
    "Combat",
    join(repoRoot, "packages/verification/dist/test/real-combat.test.js"),
  ],
  [
    "Combat progression",
    join(repoRoot, "packages/verification/dist/test/real-combat-progression.test.js"),
  ],
  [
    "Desktop save",
    join(repoRoot, "packages/verification/dist/test/real-desktop-save.test.js"),
  ],
];

for (const [label, testFile] of suites) {
  console.log(`Running packaged Linux suite: ${label}`);
  const testRun = spawnSync(process.execPath, ["--test", testFile], {
    stdio: "inherit",
    env: {
      ...process.env,
      KINETRA_RUNTIME_EXECUTABLE: exe,
    },
  });
  if (testRun.status !== 0) {
    throw new Error(
      `Packaged Linux suite "${label}" failed with exit code ${String(testRun.status)}`,
    );
  }
  await waitForExit();
  assertNoPackagedProcesses(`after suite ${label}`);
}

console.log("Packaged Linux KinetraGame acceptance passed.");

async function runBootSmoke() {
  const exitCode = await new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, ["--smoke-test", ...LINUX_ELECTRON_LAUNCH_ARGS], {
      stdio: "inherit",
      detached: true,
      env,
    });
    const timer = setTimeout(() => {
      killProcessGroup(child.pid);
      reject(new Error("Packaged KinetraGame smoke test timed out"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Packaged KinetraGame exited with code ${String(exitCode)}`);
  }
  console.log("Packaged Linux executable boot smoke passed.");
}

async function runBridgeIteration(iteration) {
  const host = new ElectronRuntimeHost({
    runtimeExecutable: exe,
    requestTimeoutMs: 30_000,
  });

  try {
    const ping = await host.request("ping");
    if (!ping || ping.ready !== true) {
      throw new Error(`Packaged ping failed: ${JSON.stringify(ping)}`);
    }

    const hostInfo = await host.getHostInfo();
    console.log(`PACKAGED_LINUX_HOST_INFO_${iteration}`, JSON.stringify(hostInfo));
    if (hostInfo.platform !== "linux") {
      throw new Error(`Expected platform linux, got ${String(hostInfo.platform)}`);
    }
    if (hostInfo.arch !== "x64") {
      throw new Error(`Expected arch x64, got ${String(hostInfo.arch)}`);
    }
    if (hostInfo.isPackaged !== true) {
      throw new Error(`Expected isPackaged true, got ${String(hostInfo.isPackaged)}`);
    }
    if (hostInfo.execPath !== exe) {
      throw new Error(
        `Expected execPath ${exe}, got ${String(hostInfo.execPath)}`,
      );
    }
    if (/electron(\.exe)?$/i.test(hostInfo.execPath)) {
      throw new Error(`Dev Electron executable is not packaged proof: ${hostInfo.execPath}`);
    }

    await host.start(createArenaProject(), ARENA_SCENE_ID, iteration, arenaAudioAssets);
    const before = await host.query();
    const beforeX = playerX(before);
    if (before.running !== true || before.sceneId !== ARENA_SCENE_ID) {
      throw new Error(`Arena did not start: ${JSON.stringify({
        running: before.running,
        sceneId: before.sceneId,
      })}`);
    }
    if (before.game?.status !== "playing") {
      throw new Error(`Arena status is not playing: ${JSON.stringify(before.game ?? null)}`);
    }

    await host.injectInput({
      action: "player.moveRight",
      phase: "hold",
      value: 1,
    });
    await host.step(10, 1 / 60);
    const after = await host.query();
    const afterX = playerX(after);
    if (!(afterX > beforeX)) {
      throw new Error(
        `Semantic moveRight did not advance Player x (${String(beforeX)} -> ${String(afterX)})`,
      );
    }
    console.log(
      `PACKAGED_LINUX_INPUT_${iteration}`,
      JSON.stringify({ beforeX, afterX }),
    );

    const frame = await host.captureFrame();
    if (!frame.available || !frame.base64 || frame.mimeType !== "image/png") {
      throw new Error(`Packaged captureFrame failed: ${JSON.stringify({
        available: frame.available,
        mimeType: frame.mimeType,
        reason: frame.reason,
      })}`);
    }
    const png = Buffer.from(frame.base64, "base64");
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (png.length < 1000 || !png.subarray(0, 8).equals(magic)) {
      throw new Error(`Packaged capture is not a real PNG (${png.length} bytes)`);
    }
    await mkdir(evidenceDir, { recursive: true });
    const framePath = join(evidenceDir, `frame-${iteration}.png`);
    await writeFile(framePath, png);
    console.log("PACKAGED_LINUX_PNG", framePath, String(png.length));

    const logs = await host.readLogs();
    const errors = logs.filter((entry) => entry.level === "error");
    if (errors.length > 0) {
      throw new Error(
        `Unexpected runtime error logs: ${errors.map((entry) => entry.message).join("; ")}`,
      );
    }

    await host.stop();
  } finally {
    await host.close();
  }
}

function playerX(query) {
  const player = Array.isArray(query.entities)
    ? query.entities.find((entity) => entity.name === "Player")
    : undefined;
  const x = player?.position?.[0];
  if (typeof x !== "number" || !Number.isFinite(x)) {
    const names = Array.isArray(query.entities)
      ? query.entities.map((entity) => entity.name)
      : [];
    throw new Error(`Player position is missing from runtime.query entities: ${JSON.stringify(names)}`);
  }
  return x;
}

async function waitForExit() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
}

function assertNoPackagedProcesses(label) {
  const leaked = packagedGamePids();
  if (leaked.length > 0) {
    throw new Error(
      `Leaked packaged KinetraGame process ${label}: ${JSON.stringify(leaked)}`,
    );
  }
}

function killProcessGroup(pid) {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
}

function packagedGamePids() {
  const pids = [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || entry === String(process.pid)) {
      continue;
    }
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      const text = cmdline.replaceAll("\0", " ");
      if (text.includes(exe)) {
        pids.push({ pid: entry, cmdline: text.slice(0, 240) });
      }
    } catch {
      // Process exited between readdir and read.
    }
  }
  return pids;
}
