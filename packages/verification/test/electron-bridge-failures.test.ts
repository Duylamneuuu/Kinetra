import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ElectronRuntimeHost } from "../src/index.js";

/**
 * Stdio bridge whose process closes its stdin before it announces "ready": the host's next write
 * hits a pipe with no reader (EPIPE), which Node reports as an asynchronous "error" event on
 * child.stdin. Nothing listened for it, so it was an uncaught exception in the host process and
 * the request in flight only failed at its timeout.
 */
const FAKE_DEAF_STDIO_PLAYER = `
import fs from "node:fs";

fs.closeSync(0);
setTimeout(() => process.stdout.write(JSON.stringify({ type: "event", event: "ready" }) + "\\n"), 300);
setTimeout(() => process.exit(0), 8000);
`;

/**
 * Pipe bridge that crashes (exit code 3) while serving its first request, and answers normally on
 * every later launch. Each launch records the user-data directory it was given and creates it.
 */
const FAKE_CRASHING_PIPE_PLAYER = `
import net from "node:net";
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.KINETRA_FAKE_LAUNCH_LOG;
fs.appendFileSync(log, process.env.KINETRA_USER_DATA_DIR + "\\n");
fs.mkdirSync(process.env.KINETRA_USER_DATA_DIR, { recursive: true });
const launchNumber = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;

const socket = net.connect(process.env.KINETRA_RUNTIME_BRIDGE_PIPE);
socket.on("connect", () => {
  socket.write(JSON.stringify({ type: "event", event: "ready" }) + "\\n");
});
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
readline.createInterface({ input: socket }).on("line", (line) => {
  if (launchNumber === 1) process.exit(3);
  const message = JSON.parse(line);
  socket.write(
    JSON.stringify({ type: "response", id: message.id, ok: true, result: { running: false, entities: [] } }) + "\\n",
  );
});
setTimeout(() => process.exit(0), 20000);
`;

test("a write to a bridge that closed its stdin fails the request fast instead of crashing the host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinetra-fake-deaf-"));
  const playerEntry = join(directory, "fake-player.mjs");
  await writeFile(playerEntry, FAKE_DEAF_STDIO_PLAYER, "utf8");

  const host = new ElectronRuntimeHost({
    electronExecutable: process.execPath,
    runtimeExecutable: undefined,
    playerEntry,
    transport: "stdio",
    requestTimeoutMs: 3_000,
    userDataDir: join(directory, "user-data"),
  });

  const uncaught: string[] = [];
  const onUncaught = (error: Error): void => {
    uncaught.push(error.message);
  };
  process.on("uncaughtException", onUncaught);

  try {
    const started = Date.now();
    await assert.rejects(host.query(), /bridge stdin failed/);
    assert.ok(
      Date.now() - started < 2_500,
      "the request must fail from the write error, not wait for its timeout",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await host.close();
  }
});

test(
  "a bridge process that crashed does not leak its server or temp user-data directory on restart",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "kinetra-fake-crash-"));
    const playerEntry = join(directory, "fake-player.mjs");
    const launchLog = join(directory, "launches.log");
    await writeFile(playerEntry, FAKE_CRASHING_PIPE_PLAYER, "utf8");
    await writeFile(launchLog, "", "utf8");
    process.env.KINETRA_FAKE_LAUNCH_LOG = launchLog;

    // No userDataDir: the host owns a temp directory per launch and must clean each one up.
    const host = new ElectronRuntimeHost({
      electronExecutable: process.execPath,
      runtimeExecutable: undefined,
      playerEntry,
      requestTimeoutMs: 10_000,
    });

    const socketFiles = (): string[] =>
      readdirSync(tmpdir()).filter(
        (name) => name.startsWith(`kinetra-runtime-${process.pid}-`) && name.endsWith(".sock"),
      );

    try {
      await assert.rejects(host.query(), /exited/);
      const afterRestart = await host.query();
      assert.equal(afterRestart.running, false);

      assert.equal(
        socketFiles().length,
        1,
        "only the restarted bridge may still be listening; the crashed one's server must be closed",
      );
    } finally {
      await host.close();
      delete process.env.KINETRA_FAKE_LAUNCH_LOG;
    }

    const userDataDirs = (await readFile(launchLog, "utf8")).split("\n").filter(Boolean);
    assert.equal(userDataDirs.length, 2, "expected the crash launch plus one restart");
    for (const userDataDir of userDataDirs) {
      assert.equal(existsSync(userDataDir), false, `temp user-data dir ${userDataDir} was leaked`);
    }
  },
);
