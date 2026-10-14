import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ElectronRuntimeHost } from "../src/index.js";

/**
 * Stdio bridge whose first launch never announces "ready" (a renderer stuck while starting) and
 * whose later launches answer queries normally. Each launch appends "<pid>" to the launch log.
 */
const FAKE_NEVER_READY_THEN_READY_PLAYER = `
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.KINETRA_FAKE_LAUNCH_LOG;
fs.appendFileSync(log, process.pid + "\\n");
const launchNumber = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;

if (launchNumber === 1) {
  setTimeout(() => process.exit(0), 30000);
} else {
  process.stdout.write(JSON.stringify({ type: "event", event: "ready" }) + "\\n");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    process.stdout.write(
      JSON.stringify({ type: "response", id: message.id, ok: true, result: { running: false, entities: [] } }) + "\\n",
    );
  }).on("close", () => process.exit(0));
  setTimeout(() => process.exit(0), 20000);
}
`;

const wait = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launchedPids(launchLog: string): Promise<number[]> {
  return (await readFile(launchLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line));
}

test(
  "a bridge that never becomes ready is torn down at the ready timeout and the next request launches a fresh one",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "kinetra-fake-ready-timeout-"));
    const playerEntry = join(directory, "fake-player.mjs");
    const launchLog = join(directory, "launches.log");
    await writeFile(playerEntry, FAKE_NEVER_READY_THEN_READY_PLAYER, "utf8");
    await writeFile(launchLog, "", "utf8");
    process.env.KINETRA_FAKE_LAUNCH_LOG = launchLog;

    const host = new ElectronRuntimeHost({
      electronExecutable: process.execPath,
      runtimeExecutable: undefined,
      playerEntry,
      transport: "stdio",
      requestTimeoutMs: 1_500,
      userDataDir: join(directory, "user-data"),
    });

    try {
      await assert.rejects(host.query(), /Timed out waiting for Electron runtime bridge ready signal/);
      const [stuckPid] = await launchedPids(launchLog);
      assert.ok(stuckPid !== undefined && stuckPid > 0, "the stuck bridge must have launched");

      // The timed-out bridge must not be left running as an orphan.
      for (let attempt = 0; attempt < 20 && isAlive(stuckPid); attempt += 1) {
        await wait(100);
      }
      assert.equal(isAlive(stuckPid), false, "the bridge that never became ready is still running");

      // And the host must not stay poisoned by the dead startup: the next request starts a new bridge.
      const result = await host.query();
      assert.equal(result.running, false);
      assert.equal((await launchedPids(launchLog)).length, 2);
    } finally {
      delete process.env.KINETRA_FAKE_LAUNCH_LOG;
      await host.close();
    }
  },
);
