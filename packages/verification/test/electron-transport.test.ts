import assert from "node:assert/strict";
import test from "node:test";

import { ElectronRuntimeHost } from "../src/index.js";

test("ElectronRuntimeHost defaults to the pipe transport with no extra Electron args", () => {
  const host = new ElectronRuntimeHost();
  assert.equal(host.transport, "pipe");
  assert.deepEqual([...host.electronArgs], []);
});

test("ElectronRuntimeHost accepts an explicit stdio transport with Electron args", () => {
  const host = new ElectronRuntimeHost({
    transport: "stdio",
    electronArgs: ["--no-sandbox", "--disable-gpu"],
  });
  assert.equal(host.transport, "stdio");
  assert.deepEqual([...host.electronArgs], ["--no-sandbox", "--disable-gpu"]);
});

test("ElectronRuntimeHost copies Electron args instead of retaining the caller array", () => {
  const args = ["--no-sandbox"];
  const host = new ElectronRuntimeHost({ electronArgs: args });
  args.push("--disable-gpu");
  assert.deepEqual([...host.electronArgs], ["--no-sandbox"]);
});

test("ElectronRuntimeHost.close without a started process is safe and idempotent", async () => {
  const host = new ElectronRuntimeHost({ transport: "stdio" });
  await host.close();
  await host.close();
});
