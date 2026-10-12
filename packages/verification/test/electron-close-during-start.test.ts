import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ElectronRuntimeHost } from "../src/index.js";

/**
 * Stdio bridge whose first launch never announces "ready" (a renderer stuck while starting) and
 * whose later launches answer queries normally. Each launch appends a line to the launch log.
 */
const FAKE_SLOW_START_PLAYER = `
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.KINETRA_FAKE_LAUNCH_LOG;
fs.appendFileSync(log, "launch\\n");
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

async function prepare(): Promise<{ directory: string; playerEntry: string; launchLog: string }> {
  const directory = await mkdtemp(join(tmpdir(), "kinetra-fake-close-start-"));
  const playerEntry = join(directory, "fake-player.mjs");
  const launchLog = join(directory, "launches.log");
  await writeFile(playerEntry, FAKE_SLOW_START_PLAYER, "utf8");
  await writeFile(launchLog, "", "utf8");
  process.env.KINETRA_FAKE_LAUNCH_LOG = launchLog;
  return { directory, playerEntry, launchLog };
}

async function launchCount(launchLog: string): Promise<number> {
  return (await readFile(launchLog, "utf8")).split("\n").filter(Boolean).length;
}

const wait = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

// The fake bridge relies on POSIX process groups to be torn down by close().
const posixOnly = { skip: process.platform === "win32" };

test(
  "close() while the bridge is still starting fails the waiting request at once instead of after the ready timeout",
  posixOnly,
  async () => {
    const { directory, playerEntry } = await prepare();
    const host = new ElectronRuntimeHost({
      electronExecutable: process.execPath,
      runtimeExecutable: undefined,
      playerEntry,
      transport: "stdio",
      requestTimeoutMs: 6_000,
      userDataDir: join(directory, "user-data"),
    });

    try {
      const startedAt = Date.now();
      const request = host.query().then(
        () => undefined,
        (error: unknown) => error,
      );
      await wait(400);
      await host.close();
      const outcome = await request;
      const elapsedMs = Date.now() - startedAt;

      assert.ok(outcome instanceof Error, "the request waiting for the bridge must fail");
      assert.match(outcome.message, /closed/);
      assert.ok(elapsedMs < 3_000, `request must fail promptly after close(), took ${elapsedMs}ms`);
    } finally {
      delete process.env.KINETRA_FAKE_LAUNCH_LOG;
      await host.close();
    }
  },
);

test(
  "a request issued after close() interrupted a startup launches a fresh bridge instead of reusing the dead startup",
  posixOnly,
  async () => {
    const { directory, playerEntry, launchLog } = await prepare();
    const host = new ElectronRuntimeHost({
      electronExecutable: process.execPath,
      runtimeExecutable: undefined,
      playerEntry,
      transport: "stdio",
      requestTimeoutMs: 6_000,
      userDataDir: join(directory, "user-data"),
    });

    try {
      const first = host.query().then(
        () => undefined,
        (error: unknown) => error,
      );
      await wait(400);
      await host.close();

      // Do not wait for the interrupted request first: the new request must not join its startup.
      const startedAt = Date.now();
      const result = await host.query();
      const elapsedMs = Date.now() - startedAt;
      assert.ok((await first) instanceof Error);

      assert.equal(result.running, false);
      assert.ok(elapsedMs < 3_000, `second bridge must start promptly, took ${elapsedMs}ms`);
      assert.equal(await launchCount(launchLog), 2);
    } finally {
      delete process.env.KINETRA_FAKE_LAUNCH_LOG;
      await host.close();
    }
  },
);
