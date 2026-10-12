import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ElectronRuntimeHost } from "../src/index.js";

/**
 * Stdio bridge whose first launch closes its stdin (the host's first write fails with EPIPE and
 * the host marks stdin destroyed) and lingers for a few seconds; every later launch answers
 * queries normally until its stdin closes. Each launch appends a line to the launch log.
 */
const FAKE_STDIO_PLAYER = `
import fs from "node:fs";
import readline from "node:readline";

const log = process.env.KINETRA_FAKE_LAUNCH_LOG;
fs.appendFileSync(log, "launch\\n");
const launchNumber = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;

if (launchNumber === 1) {
  fs.closeSync(0);
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "event", event: "ready" }) + "\\n"), 300);
  setTimeout(() => process.exit(0), 8000);
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

async function prepare(prefix: string, source: string): Promise<{
  directory: string;
  playerEntry: string;
  launchLog: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const playerEntry = join(directory, "fake-player.mjs");
  const launchLog = join(directory, "launches.log");
  await writeFile(playerEntry, source, "utf8");
  await writeFile(launchLog, "", "utf8");
  process.env.KINETRA_FAKE_LAUNCH_LOG = launchLog;
  return { directory, playerEntry, launchLog };
}

async function launchCount(launchLog: string): Promise<number> {
  return (await readFile(launchLog, "utf8")).split("\n").filter(Boolean).length;
}

// The fake bridges rely on POSIX pipe semantics (EPIPE on a closed fd 0, process groups).
const posixOnly = { skip: process.platform === "win32" };

test(
  "a request issued while close() is tearing the bridge down launches a replacement that survives the teardown",
  posixOnly,
  async () => {
    const { directory, playerEntry, launchLog } = await prepare("kinetra-fake-close-", FAKE_STDIO_PLAYER);
    const host = new ElectronRuntimeHost({
      electronExecutable: process.execPath,
      runtimeExecutable: undefined,
      playerEntry,
      transport: "stdio",
      requestTimeoutMs: 5_000,
      userDataDir: join(directory, "user-data"),
    });

    try {
      await assert.rejects(host.query(), /bridge stdin failed/);

      const closing = host.close();
      const replacement = await host.query();
      assert.equal(replacement.running, false);
      await closing;

      // close() finished after the replacement was serving; it must not have reset the
      // replacement's state (which would make the next request launch a third process).
      assert.equal((await host.query()).running, false);
      assert.equal(await launchCount(launchLog), 2);
    } finally {
      delete process.env.KINETRA_FAKE_LAUNCH_LOG;
      await host.close();
    }
  },
);

test("concurrent close() calls share one teardown", posixOnly, async () => {
  const { directory, playerEntry, launchLog } = await prepare("kinetra-fake-close2-", FAKE_STDIO_PLAYER);
  // Launch 1 is the deaf one; burn it so this test talks to a responsive bridge.
  appendFileSync(launchLog, "launch\n");
  const host = new ElectronRuntimeHost({
    electronExecutable: process.execPath,
    runtimeExecutable: undefined,
    playerEntry,
    transport: "stdio",
    requestTimeoutMs: 5_000,
    userDataDir: join(directory, "user-data"),
  });

  try {
    assert.equal((await host.query()).running, false);
    const first = host.close();
    const second = host.close();
    assert.strictEqual(first, second);
    await Promise.all([first, second]);
    // A closed host starts a fresh bridge on demand.
    assert.equal((await host.query()).running, false);
    assert.equal(await launchCount(launchLog), 3);
  } finally {
    delete process.env.KINETRA_FAKE_LAUNCH_LOG;
    await host.close();
  }
});

test("close() while the pipe server is still binding does not launch an unowned process", posixOnly, async () => {
  const { playerEntry, launchLog } = await prepare("kinetra-fake-close3-", FAKE_STDIO_PLAYER);
  const host = new ElectronRuntimeHost({
    electronExecutable: process.execPath,
    runtimeExecutable: undefined,
    playerEntry,
    requestTimeoutMs: 3_000,
  });

  try {
    const request = host.query().then(
      () => undefined,
      (error: unknown) => error,
    );
    await host.close();
    const outcome = await request;
    assert.ok(outcome instanceof Error, "the request started before close() must fail");
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.equal(await launchCount(launchLog), 0, "no bridge process may be launched after close()");
  } finally {
    delete process.env.KINETRA_FAKE_LAUNCH_LOG;
    await host.close();
  }
});
