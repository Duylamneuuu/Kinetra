import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLinuxHostInfo,
  assertSemanticMove,
  descendantPids,
  inspectPng,
  pidsUsingPath,
} from "./linux-smoke-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const playerRoot = resolve(here, "..");
const repoRoot = resolve(playerRoot, "../..");
const repeats = positiveInt(process.env.KINETRA_LINUX_SMOKE_REPEATS, 2);
const readyTimeoutMs = positiveInt(process.env.KINETRA_LINUX_SMOKE_READY_MS, 45_000);
const requestTimeoutMs = positiveInt(
  process.env.KINETRA_LINUX_SMOKE_REQUEST_MS,
  30_000,
);

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main() {
  if (process.platform !== "linux") {
    throw new Error(
      "smoke:linux must run on Linux. It is the dev-Electron xvfb proof. Windows packaged proof remains smoke:win / KinetraGame.exe.",
    );
  }

  ensureDisplay();

  if (process.env.KINETRA_SMOKE_SKIP_BUILD !== "1") {
    console.log("Building @kinetra/player and its workspace dependencies...");
    const build = spawnSync(
      "pnpm",
      ["--filter", "@kinetra/player...", "build"],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env,
      },
    );
    if (build.status !== 0) {
      throw new Error(
        `Player build failed with exit code ${String(build.status)}`,
      );
    }
  }

  const referenceGame = await import("@kinetra/reference-game");
  const framePath =
    process.env.KINETRA_LINUX_SMOKE_FRAME ??
    join(tmpdir(), "kinetra-linux-smoke-frame.png");

  /** @type {unknown[]} */
  const sessions = [];
  for (let index = 1; index <= repeats; index += 1) {
    console.log(`Linux Electron smoke session ${index}/${repeats}`);
    sessions.push(
      await runSession(
        index,
        referenceGame,
        index === repeats ? framePath : undefined,
      ),
    );
  }

  console.log("KINETRA_LINUX_SMOKE_PASS");
  console.log(
    JSON.stringify(
      {
        proof: "linux-dev-electron",
        command: "pnpm --filter @kinetra/player smoke:linux",
        notProofOf: "windows-packaged-KinetraGame.exe",
        repeats,
        framePath,
        sessions,
      },
      null,
      2,
    ),
  );
}

function ensureDisplay() {
  if (process.env.DISPLAY) {
    return;
  }
  if (process.env.KINETRA_SMOKE_INSIDE_XVFB === "1") {
    throw new Error("xvfb-run completed without setting DISPLAY");
  }

  console.log("DISPLAY is unset. Relaunching smoke under xvfb-run.");
  const child = spawnSync(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1280x720x24",
      process.execPath,
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        KINETRA_SMOKE_INSIDE_XVFB: "1",
      },
    },
  );
  process.exit(child.status ?? 1);
}

/**
 * @param {number} index
 * @param {{
 *   createArenaProject: () => unknown;
 *   ARENA_SCENE_ID: string;
 *   arenaAudioAssets: Record<string, string>;
 * }} referenceGame
 * @param {string | undefined} framePath
 */
async function runSession(index, referenceGame, framePath) {
  const userDataDir = await mkdtemp(join(tmpdir(), "kinetra-linux-smoke-"));
  const playerEntry = join(playerRoot, "dist", "package");
  const env = {
    ...process.env,
    KINETRA_RUNTIME_BRIDGE_STDIO: "1",
    KINETRA_USER_DATA_DIR: userDataDir,
    LIBGL_ALWAYS_SOFTWARE: "1",
    GALLIUM_DRIVER: "llvmpipe",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
  };
  delete env.ELECTRON_RUN_AS_NODE;

  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  /** @type {StdioBridge | undefined} */
  let bridge;

  try {
    child = spawn(
      electronBinary(),
      [
        playerEntry,
        "--runtime-bridge-stdio",
        `--user-data-dir=${userDataDir}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ozone-platform=x11",
      ],
      {
        cwd: playerEntry,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      },
    );
    bridge = new StdioBridge(child, readyTimeoutMs, requestTimeoutMs);
    await bridge.ready();

    const ping = await bridge.request("ping");
    if (!isRecord(ping) || ping.ready !== true) {
      throw new Error(`ping did not return { ready: true }: ${JSON.stringify(ping)}`);
    }

    const hostInfo = assertLinuxHostInfo(await bridge.request("runtime.hostInfo"));
    const projectRevision = 3;
    await bridge.request("runtime.start", {
      project: referenceGame.createArenaProject(),
      sceneId: referenceGame.ARENA_SCENE_ID,
      projectRevision,
      assets: referenceGame.arenaAudioAssets,
    });

    const started = await bridge.request("runtime.query");
    assertArenaBoot(started, referenceGame.ARENA_SCENE_ID, projectRevision);

    await bridge.request("runtime.injectInput", {
      action: "player.moveForward",
      phase: "press",
      value: 1,
    });
    const stepped = await bridge.request("runtime.step", {
      steps: 1,
      deltaSeconds: 1 / 60,
    });
    const movement = assertSemanticMove(started, stepped);

    const frame = await bridge.request("runtime.captureFrame");
    const png = assertCapturedPng(frame);
    if (framePath) {
      await writeFile(framePath, Buffer.from(requiredBase64(frame), "base64"));
    }

    const stopped = await bridge.request("runtime.stop");
    if (!isRecord(stopped) || stopped.stopped !== true) {
      throw new Error(`runtime.stop failed: ${JSON.stringify(stopped)}`);
    }
    const idle = await bridge.request("runtime.query");
    if (!isRecord(idle) || idle.running !== false) {
      throw new Error(`runtime did not stop: ${JSON.stringify(idle)}`);
    }

    console.log(
      `session ${index}: host=${hostInfo.platform}/${hostInfo.arch} player z ${movement.beforeZ} -> ${movement.afterZ} png ${png.width}x${png.height} (${png.byteLength} bytes, ${png.uniqueBytes} unique)`,
    );

    return { hostInfo, movement, png, stopped: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = bridge?.stderrTail() ?? "";
    throw new Error(
      stderr.length > 0 ? `${message}\n--- electron stderr ---\n${stderr}` : message,
    );
  } finally {
    if (child) {
      await stopElectron(child, userDataDir);
    }
    await rm(userDataDir, { recursive: true, force: true });
  }
}

/**
 * @param {unknown} query
 * @param {string} sceneId
 * @param {number} projectRevision
 */
function assertArenaBoot(query, sceneId, projectRevision) {
  if (!isRecord(query)) {
    throw new Error("runtime.query did not return an object");
  }
  if (query.running !== true) {
    throw new Error("Kinetra Arena did not enter the running state");
  }
  if (query.sceneId !== sceneId) {
    throw new Error(`sceneId is ${String(query.sceneId)}, expected ${sceneId}`);
  }
  if (query.projectRevision !== projectRevision) {
    throw new Error(
      `projectRevision is ${String(query.projectRevision)}, expected ${projectRevision}`,
    );
  }
  if (!isRecord(query.game) || query.game.status !== "playing") {
    throw new Error(
      `Arena session status is ${JSON.stringify(query.game)}, expected playing`,
    );
  }
  if (!isRecord(query.shell) || query.shell.mode !== "playing") {
    throw new Error(`shell mode is ${JSON.stringify(query.shell)}, expected playing`);
  }
  if (!Array.isArray(query.entities)) {
    throw new Error("runtime.query is missing entities");
  }
}

/**
 * @param {unknown} frame
 */
function assertCapturedPng(frame) {
  if (!isRecord(frame) || frame.available !== true || frame.mimeType !== "image/png") {
    throw new Error(
      `runtime.captureFrame did not return a PNG: ${JSON.stringify(summarize(frame))}`,
    );
  }
  return inspectPng(Buffer.from(requiredBase64(frame), "base64"));
}

/**
 * @param {Record<string, unknown>} frame
 */
function requiredBase64(frame) {
  if (typeof frame.base64 !== "string" || frame.base64.length === 0) {
    throw new Error("runtime.captureFrame returned no base64 PNG");
  }
  return frame.base64;
}

function electronBinary() {
  const require = createRequire(join(playerRoot, "package.json"));
  const executable = require("electron");
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("Could not resolve the Electron executable from @kinetra/player");
  }
  return executable;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} userDataDir
 */
async function stopElectron(child, userDataDir) {
  const pid = child.pid;
  try {
    child.stdin?.end();
  } catch {
    // The bridge may already be closed.
  }

  if (pid) {
    signalOwnedProcesses(pid, userDataDir, "SIGTERM");
  }
  const exited = await waitForExit(child, 4_000);
  if (pid && (exited === null || ownedPids(pid, userDataDir).length > 0)) {
    signalOwnedProcesses(pid, userDataDir, "SIGKILL");
    await waitForExit(child, 4_000);
    await delay(200);
  }

  const leaked = ownedPids(pid ?? -1, userDataDir);
  if (leaked.length > 0) {
    const details = listProcesses()
      .filter((proc) => leaked.includes(proc.pid))
      .map((proc) => `${proc.pid} ${proc.cmdline}`)
      .join("\n");
    throw new Error(
      `Electron processes still running after Linux smoke teardown:\n${details}`,
    );
  }
}

/**
 * @param {number} pid
 * @param {string} userDataDir
 * @param {NodeJS.Signals} signal
 */
function signalOwnedProcesses(pid, userDataDir, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may already be gone.
  }
  for (const victim of ownedPids(pid, userDataDir)) {
    try {
      process.kill(victim, signal);
    } catch {
      // Already exited.
    }
  }
}

/**
 * @param {number} rootPid
 * @param {string} userDataDir
 */
function ownedPids(rootPid, userDataDir) {
  const processes = listProcesses();
  const live = new Set(processes.map((proc) => proc.pid));
  const descendants = rootPid > 0 ? descendantPids(processes, rootPid) : [];
  const marked = pidsUsingPath(processes, userDataDir);
  const candidates = [...descendants, ...marked];
  if (rootPid > 0 && live.has(rootPid)) {
    candidates.push(rootPid);
  }
  return [...new Set(candidates)];
}

/**
 * @returns {{ pid: number; ppid: number; cmdline: string; environ: string }[]}
 */
function listProcesses() {
  /** @type {{ pid: number; ppid: number; cmdline: string; environ: string }[]} */
  const processes = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const cmdline = readFileSync(join("/proc", entry, "cmdline"))
        .toString("utf8")
        .replaceAll("\0", " ")
        .trim();
      const status = readFileSync(join("/proc", entry, "status"), "utf8");
      const match = status.match(/^PPid:\s+(\d+)/m);
      let environ = "";
      try {
        environ = readFileSync(join("/proc", entry, "environ"))
          .toString("utf8")
          .replaceAll("\0", "\n");
      } catch {
        environ = "";
      }
      processes.push({
        pid: Number(entry),
        ppid: match ? Number(match[1]) : 0,
        cmdline,
        environ,
      });
    } catch {
      // Process exited while we were reading.
    }
  }
  return processes;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 */
function summarize(value) {
  if (!isRecord(value)) {
    return value;
  }
  const copy = { ...value };
  if (typeof copy.base64 === "string") {
    copy.base64 = `<${copy.base64.length} chars>`;
  }
  return copy;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class StdioBridge {
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
  #child;
  #buffer = "";
  #stderr = "";
  #nextId = 1;
  #requestTimeoutMs;
  /** @type {Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>} */
  #pending = new Map();
  /** @type {Promise<void>} */
  #ready;
  /** @type {(() => void) | undefined} */
  #resolveReady;
  /** @type {((error: Error) => void) | undefined} */
  #rejectReady;

  /**
   * @param {import("node:child_process").ChildProcess} child
   * @param {number} readyTimeoutMs
   * @param {number} requestTimeoutMs
   */
  constructor(child, readyTimeoutMs, requestTimeoutMs) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Electron stdio pipes are unavailable");
    }
    this.#child = /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (
      child
    );
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(
          new Error(
            `Timed out waiting for the Electron stdio bridge ready event after ${readyTimeoutMs}ms`,
          ),
        );
      }, readyTimeoutMs);
      this.#resolveReady = () => {
        clearTimeout(timer);
        resolveReady();
      };
      this.#rejectReady = (error) => {
        clearTimeout(timer);
        rejectReady(error);
      };
    });

    this.#child.stdout.on("data", (chunk) => {
      this.#buffer += Buffer.from(chunk).toString("utf8");
      this.#drain();
    });
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += Buffer.from(chunk).toString("utf8");
      if (this.#stderr.length > 64_000) {
        this.#stderr = this.#stderr.slice(-64_000);
      }
    });
    this.#child.once("error", (error) => {
      this.#failAll(error);
    });
    this.#child.once("exit", (code, signal) => {
      this.#failAll(
        new Error(
          `Electron exited before the smoke finished (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
  }

  ready() {
    return this.#ready;
  }

  stderrTail() {
    return this.#stderr.trim();
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  request(method, params = {}) {
    const id = `linux_smoke_${this.#nextId++}`;
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectResponse(
          new Error(
            `Runtime request "${method}" timed out after ${this.#requestTimeoutMs}ms`,
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        resolve: resolveResponse,
        reject: rejectResponse,
        timer,
      });
    });

    this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, "utf8");
    return response;
  }

  #drain() {
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) {
        this.#handleLine(line);
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  /**
   * @param {string} line
   */
  #handleLine(line) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return;
    }
    if (parsed.type === "event" && parsed.event === "ready") {
      this.#resolveReady?.();
      return;
    }
    if (parsed.type === "event" && parsed.event === "fatal") {
      this.#failAll(
        new Error(
          typeof parsed.message === "string"
            ? parsed.message
            : "Electron runtime bridge reported a fatal event",
        ),
      );
      return;
    }
    if (
      parsed.type !== "response" ||
      typeof parsed.id !== "string" ||
      typeof parsed.ok !== "boolean"
    ) {
      return;
    }

    const pending = this.#pending.get(parsed.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(parsed.id);
    if (parsed.ok) {
      pending.resolve(parsed.result);
    } else {
      pending.reject(
        new Error(
          typeof parsed.error === "string"
            ? parsed.error
            : `Runtime request ${parsed.id} failed`,
        ),
      );
    }
  }

  /**
   * @param {Error} error
   */
  #failAll(error) {
    this.#rejectReady?.(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

if (invokedDirectly) {
  await main();
}
