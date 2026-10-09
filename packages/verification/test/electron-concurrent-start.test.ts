import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ElectronRuntimeHost } from "../src/index.js";

/**
 * A stand-in for the Electron player: connects to the host's bridge pipe, announces "ready" and
 * answers every request with an empty runtime snapshot. It records each launch so the test can
 * count how many processes the host spawned.
 */
const FAKE_PLAYER = `
import net from "node:net";
import fs from "node:fs";
import readline from "node:readline";

fs.appendFileSync(process.env.KINETRA_FAKE_LAUNCH_LOG, "launch\\n");
const socket = net.connect(process.env.KINETRA_RUNTIME_BRIDGE_PIPE);
socket.on("connect", () => {
  socket.write(JSON.stringify({ type: "event", event: "ready" }) + "\\n");
});
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
readline.createInterface({ input: socket }).on("line", (line) => {
  const message = JSON.parse(line);
  socket.write(
    JSON.stringify({ type: "response", id: message.id, ok: true, result: { running: false, entities: [] } }) + "\\n",
  );
});
setTimeout(() => process.exit(0), 20000);
`;

test("concurrent first requests share one Electron process instead of spawning one each", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinetra-fake-player-"));
  const playerEntry = join(directory, "fake-player.mjs");
  const launchLog = join(directory, "launches.log");
  await writeFile(playerEntry, FAKE_PLAYER, "utf8");
  await writeFile(launchLog, "", "utf8");
  process.env.KINETRA_FAKE_LAUNCH_LOG = launchLog;

  const host = new ElectronRuntimeHost({
    electronExecutable: process.execPath,
    runtimeExecutable: undefined,
    playerEntry,
    requestTimeoutMs: 10_000,
    userDataDir: join(directory, "user-data"),
  });

  try {
    const results = await Promise.all([host.query(), host.query(), host.query()]);
    assert.equal(results.length, 3);

    const launches = (await readFile(launchLog, "utf8")).split("\n").filter(Boolean);
    assert.equal(
      launches.length,
      1,
      `expected one bridge process for concurrent first requests, got ${launches.length}`,
    );
  } finally {
    await host.close();
    delete process.env.KINETRA_FAKE_LAUNCH_LOG;
  }
});
